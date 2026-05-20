"""
Talon ↔ google-antigravity Python bridge.

This script is spawned as a long-lived child process by Talon's
TypeScript Antigravity backend. It hosts the
`google.antigravity.Agent` context manager (which in turn spawns the
SDK's `localharness` binary), and translates between:

  - **stdin**: line-delimited JSON commands from Talon
    (`{"type": "chat", "id": "...", "prompt": "..."}`,
     `{"type": "abort", "id": "..."}`,
     `{"type": "shutdown"}`).

  - **stdout**: line-delimited JSON events to Talon
    (`{"type": "ready"}` — emitted once the agent context is open;
     `{"type": "text", "id": "...", "text": "..."}`;
     `{"type": "thought", "id": "...", "text": "..."}`;
     `{"type": "tool_call", "id": "...", "name": "...", "args": {...}, "tool_id": "..."}`;
     `{"type": "tool_result", "id": "...", "name": "...", "tool_id": "...",
        "error": "..." | None}`;
     `{"type": "done", "id": "...", "usage": {...}}`;
     `{"type": "error", "id": "..." | None, "error": "..."}`;
     `{"type": "log", "level": "...", "message": "..."}`).

All errors are caught and reported as `error` events; the bridge stays
alive until it receives `{"type": "shutdown"}` or EOF on stdin.

The bridge is intentionally minimal — it does NOT perform any Talon-side
delivery logic (`end_turn` / `send` / `react`), session storage, or
prompt rewriting. Those live in the TypeScript handler. Tools are
exposed via MCP servers (configured by Talon in `--mcp-config-json`)
rather than as Python callables, so the agent's tool surface is
identical to what every other Talon backend sees.

Spawn protocol (all paths in JSON; pipes are line-delimited):

  python3 agent_bridge.py --config-fd 3

  ...where fd 3 is a one-shot read-only pipe carrying a single JSON
  document with: gemini_api_key, model, system_instructions,
  workspaces, mcp_servers, save_dir, app_data_dir. The bridge reads
  config from that fd (NOT stdin) so subsequent stdin reads are
  reserved for commands.

Why fd 3 instead of an arg: API keys on argv leak into `ps`; on
stdin would collide with the command channel; an env var would
require shell-level care. fd 3 is local to the spawn and dies with
the process.

For local development without a spawn harness, pass `--config-stdin`
to read the JSON config as the *first* stdin line. Use the
`scripts/antigravity-repl.sh` helper for interactive testing.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import traceback
from typing import Any

# Bridge protocol version. Bumped when the JSON event shape changes
# in an incompatible way. Talon's TS side asserts this matches its
# expected version on the first `ready` event.
BRIDGE_PROTOCOL_VERSION = 1


# ── Direct MCP supervision ─────────────────────────────────────────────────
#
# Rather than handing MCP server specs to the antigravity SDK (which has
# several known bugs around env, tool-name namespacing, and stdout
# tolerance — see git history of this file), we connect to each MCP
# stdio server ourselves via the official `mcp` Python lib, list its
# tools, wrap them as plain Python callables, and hand the wrapped
# functions to LocalAgentConfig via `tools=[...]`. The SDK's
# `mcp_servers=[...]` path is bypassed entirely.
#
# Benefits over the patched approach we used before:
#
#   - **Env vars actually reach the child.** `StdioServerParameters`
#     accepts `env=...`; the SDK's `McpStdioServer` pydantic model
#     silently dropped it.
#   - **Tool-name namespacing is in our control.** `mcp_<server>__<tool>`
#     with `-` → `_` in the server segment so the names satisfy the
#     Gemini API's identifier rules.
#   - **Soft per-server failure.** If one plugin's stdio server can't be
#     initialised (bad token, missing binary, slow startup), we log and
#     skip it; the agent still comes up with the surviving tools. The
#     SDK's MCP layer treats one failure as fatal for the whole agent.
#   - **No SDK monkey-patches.** Nothing to rebreak on the next
#     `google-antigravity` release.


# Gemini's `Schema` type is a strict subset of JSON Schema (Open API
# 3.0-flavoured). It rejects several constructs that MCP servers freely
# emit: `enum` arrays containing non-string values, uppercase `type`
# values, dialect anchors (`$schema`, `$id`), arbitrary metadata keys,
# `additionalProperties` schemas, etc. The Go-side validator surfaces
# this as `failed to unmarshal tool schema` and tears the whole agent
# down on the next turn.
#
# Walk the schema once and normalise it into the supported subset.
# Anything we can't represent gets dropped (better than rejection by
# the server) while leaving the documented identity intact so the
# model still sees the parameter shape correctly.
_GEMINI_TYPES = {"string", "number", "integer", "boolean", "array", "object"}
_GEMINI_KEYS = {
    "type",
    "description",
    "title",
    "format",
    "enum",
    "properties",
    "required",
    "items",
    "minimum",
    "maximum",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "nullable",
    "default",
    "anyOf",
}


def _sanitise_schema_for_gemini(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema

    out: dict[str, Any] = {}
    for k, v in schema.items():
        if k not in _GEMINI_KEYS:
            continue

        if k == "type":
            if isinstance(v, list):
                # Tuple types — pick the first non-null. Gemini does
                # `nullable: true` for unions with null.
                non_null = [t for t in v if t != "null"]
                if not non_null:
                    continue
                if "null" in v:
                    out["nullable"] = True
                v = non_null[0]
            if isinstance(v, str):
                lv = v.lower()
                if lv not in _GEMINI_TYPES:
                    continue
                out[k] = lv
            continue

        if k == "enum" and isinstance(v, list):
            # Gemini wants all-string enums. Coerce; drop empties.
            out[k] = [str(item) for item in v if item is not None]
            continue

        if k == "properties" and isinstance(v, dict):
            out[k] = {
                pk: _sanitise_schema_for_gemini(pv) for pk, pv in v.items()
            }
            continue

        if k == "items":
            out[k] = _sanitise_schema_for_gemini(v)
            continue

        if k == "anyOf" and isinstance(v, list):
            cleaned = [_sanitise_schema_for_gemini(sub) for sub in v]
            cleaned = [s for s in cleaned if s]
            if cleaned:
                out[k] = cleaned
            continue

        out[k] = v

    # `required` referencing properties that survived sanitisation only.
    if "required" in out and "properties" in out:
        props = set(out["properties"].keys())
        out["required"] = [r for r in out["required"] if r in props]
        if not out["required"]:
            del out["required"]

    # Gemini wants `type` on every schema node. If the MCP server
    # omitted it but supplied `properties`, infer `object`; if it
    # supplied `items`, infer `array`. Last-resort default: `object`.
    if "type" not in out:
        if "properties" in out:
            out["type"] = "object"
        elif "items" in out:
            out["type"] = "array"
        else:
            out["type"] = "object"

    return out


# Gemini's `generateContent` refuses any tool list above 128 entries:
# `agent executor error: failed to build generate content request:
# number of tools exceeds 128`. The antigravity SDK silently adds its
# 11 built-in tools (`list_directory`, `view_file`, `run_command`,
# `finish`, …) on top of whatever we pass via `tools=[...]`, so the
# real ceiling for MCP-supplied tools is 128 − 11 = 117. We cap at
# 110 to leave a few slots for any future SDK built-in additions and
# to keep the operator-facing error away from the hard limit.
_GEMINI_TOOL_LIMIT = 110


class McpToolManager:
    """Connects to MCP stdio servers, exposes their tools as plain
    Python callables suitable for `LocalAgentConfig(tools=[...])`.

    Lifecycle is async-context-managed — use `async with`. Calling
    `connect(spec)` is the only setup step; tool-call dispatch and
    teardown are automatic. The manager enforces Gemini's per-request
    tool-count cap; tools beyond the cap are skipped (with a warning)
    so the agent still comes up.
    """

    def __init__(self) -> None:
        import contextlib

        self._stack = contextlib.AsyncExitStack()
        self._sessions: dict[str, Any] = {}
        self._tools: list[Any] = []
        # Tally of tools we connected to but had to drop for the cap.
        # Lets the operator-facing log message be specific.
        self._dropped_by_server: dict[str, int] = {}

    async def __aenter__(self) -> "McpToolManager":
        await self._stack.__aenter__()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        return await self._stack.__aexit__(exc_type, exc_val, exc_tb)

    @property
    def tools(self) -> list[Any]:
        return list(self._tools)

    async def connect(self, spec: dict[str, Any]) -> int:
        """Connect to one MCP server; register its tools. Returns the
        number of tools registered. Raises on connect failure — caller
        decides whether to swallow.
        """
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from google.antigravity.tools.tool_runner import ToolWithSchema

        name = spec["name"]
        command = spec["command"]
        args = list(spec.get("args", []))
        env_overlay = spec.get("env") or {}
        # MCP servers run as detached children — give them the full
        # parent env plus our overlay, otherwise tools like `node`
        # can't find their own binaries.
        env = {**os.environ, **env_overlay}

        params = StdioServerParameters(command=command, args=args, env=env)

        read_stream, write_stream = await self._stack.enter_async_context(
            stdio_client(params)
        )
        session = await self._stack.enter_async_context(
            ClientSession(read_stream, write_stream)
        )
        await session.initialize()

        tool_list = (await session.list_tools()).tools
        safe_server = name.replace("-", "_")

        added = 0
        dropped = 0
        for tool in tool_list:
            if len(self._tools) >= _GEMINI_TOOL_LIMIT:
                dropped += 1
                continue
            ns_name = f"mcp_{safe_server}__{tool.name}"
            wrapper = self._make_wrapper(
                session, tool.name, ns_name, tool.description or ""
            )
            input_schema = _sanitise_schema_for_gemini(
                tool.inputSchema or {"type": "object", "properties": {}}
            )
            self._tools.append(ToolWithSchema(wrapper, input_schema))
            added += 1

        if dropped:
            self._dropped_by_server[name] = dropped

        self._sessions[name] = session
        return added

    @property
    def dropped_summary(self) -> str:
        if not self._dropped_by_server:
            return ""
        parts = [
            f"{srv}({cnt})" for srv, cnt in self._dropped_by_server.items()
        ]
        return (
            f"Gemini tool cap ({_GEMINI_TOOL_LIMIT}) hit — dropped: "
            + ", ".join(parts)
        )

    @staticmethod
    def _make_wrapper(session, raw_name: str, ns_name: str, doc: str):
        async def wrapper(**kwargs: Any) -> Any:
            try:
                result = await session.call_tool(raw_name, kwargs)
            except Exception as e:  # noqa: BLE001
                # Tool failures propagate to the agent as plain text so
                # the model can recover (apologise, try a different
                # tool) instead of taking down the turn.
                return f"[tool error] {type(e).__name__}: {e}"
            # Translate `CallToolResult` → a serialisable structure.
            # The agent SDK accepts arbitrary JSON; the simplest faithful
            # form is the `.content` blocks rendered as text.
            content = getattr(result, "content", None) or []
            parts: list[str] = []
            for block in content:
                text = getattr(block, "text", None)
                if text is not None:
                    parts.append(text)
                else:
                    parts.append(str(block))
            text_blob = "\n".join(parts) if parts else ""
            if getattr(result, "isError", False):
                return f"[tool error] {text_blob or '(no detail)'}"
            return text_blob

        wrapper.__name__ = ns_name
        wrapper.__doc__ = doc
        return wrapper


def emit(event: dict[str, Any]) -> None:
    """Write a JSON event as a single line on stdout and flush."""
    sys.stdout.write(json.dumps(event, separators=(",", ":"), default=str))
    sys.stdout.write("\n")
    sys.stdout.flush()


def log(level: str, message: str) -> None:
    """Emit a log event (stderr would race with subprocess flushing)."""
    emit({"type": "log", "level": level, "message": message})


def read_config(args: argparse.Namespace) -> dict[str, Any]:
    """Read the one-shot JSON config from fd 3 or first stdin line."""
    if args.config_stdin:
        raw = sys.stdin.readline()
        if not raw:
            raise RuntimeError("No config received on stdin")
        return json.loads(raw)

    fd = args.config_fd
    chunks: list[bytes] = []
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    os.close(fd)
    raw = b"".join(chunks).decode("utf-8")
    if not raw.strip():
        raise RuntimeError("Empty config payload on fd")
    return json.loads(raw)


def build_agent_config(cfg: dict[str, Any], tools: list[Any]):
    """Translate Talon's JSON config into a LocalAgentConfig.

    `tools` is the list of `ToolWithSchema` wrappers produced by the
    `McpToolManager` — we connect to MCP servers ourselves rather than
    delegating to the SDK's broken `mcp_servers=` path.
    """
    # Imports are inside the function so a missing dependency surfaces
    # as a clean `error` event with a useful message instead of an
    # import-time crash before the bridge has a chance to emit.
    from google.antigravity import (
        CapabilitiesConfig,
        GeminiConfig,
        LocalAgentConfig,
    )
    from google.antigravity.hooks import policy

    api_key = cfg.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        log(
            "warn",
            "No Gemini API key provided — first model call will fail "
            "with 'API key not valid'. Set geminiApiKey in talon.json "
            "or GEMINI_API_KEY in env to enable.",
        )

    model = cfg.get("model")

    # Workspaces — Talon's TS side normally supplies the path (a
    # symlink under ~/talon-workspace pointing at the real
    # ~/.talon/workspace/, or an explicit override). If absent (e.g.
    # someone invoking agent_bridge.py directly for debugging),
    # fall back to a private dir under the user's home so we don't
    # touch the real workspace by accident.
    workspaces = cfg.get("workspaces")
    if not workspaces:
        default_ws = os.path.expanduser("~/talon-antigravity-fallback-workspace")
        os.makedirs(default_ws, exist_ok=True)
        workspaces = [default_ws]

    # Capabilities default = read-only. We let Talon override but
    # default to full caps so the agent can actually do work — Talon's
    # tool surface is the real safety boundary (MCP-only).
    capabilities_raw = cfg.get("capabilities")
    if capabilities_raw is True:
        capabilities = CapabilitiesConfig()
    elif capabilities_raw is None:
        capabilities = CapabilitiesConfig()
    elif capabilities_raw is False:
        capabilities = None  # LocalAgentConfig default is read-only
    else:
        capabilities = CapabilitiesConfig()

    save_dir = cfg.get("save_dir")
    app_data_dir = cfg.get("app_data_dir")
    system_instructions = cfg.get("system_instructions")

    kwargs: dict[str, Any] = {
        "gemini_config": GeminiConfig(api_key=api_key),
        "workspaces": workspaces,
        "tools": tools,
        # The SDK refuses to start with write-capable tools (which all
        # MCP-backed tools are, from its perspective) unless a policy
        # is registered. We allow everything by default — Talon's tool
        # surface is the real safety boundary, and any user-defined
        # policy override on the Talon side hasn't reached here yet.
        "policies": [policy.allow_all()],
    }
    if capabilities is not None:
        kwargs["capabilities"] = capabilities
    if model:
        kwargs["model"] = model
    if save_dir:
        kwargs["save_dir"] = save_dir
    if app_data_dir:
        kwargs["app_data_dir"] = app_data_dir
    if system_instructions:
        kwargs["system_instructions"] = system_instructions

    return LocalAgentConfig(**kwargs)


async def stream_response(agent, command_id: str, prompt: str) -> None:
    """Drive Agent.chat() and translate each chunk into a JSON event."""
    from google.antigravity.types import Text, Thought, ToolCall, ToolResult

    try:
        response = await agent.chat(prompt)
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "type": "error",
                "id": command_id,
                "error": f"chat() failed: {type(e).__name__}: {e}",
            }
        )
        return

    # Iterate the rich chunk stream so we get tool calls + thoughts too,
    # not just plain text.
    try:
        async for chunk in response.chunks:
            if isinstance(chunk, Text):
                emit(
                    {
                        "type": "text",
                        "id": command_id,
                        "text": chunk.text,
                        "step_index": chunk.step_index,
                    }
                )
            elif isinstance(chunk, Thought):
                emit(
                    {
                        "type": "thought",
                        "id": command_id,
                        "text": chunk.text,
                        "step_index": chunk.step_index,
                    }
                )
            elif isinstance(chunk, ToolCall):
                name = chunk.name
                if hasattr(name, "value"):
                    name = name.value  # BuiltinTools enum → string
                emit(
                    {
                        "type": "tool_call",
                        "id": command_id,
                        "name": str(name),
                        "args": chunk.args,
                        "tool_id": chunk.id,
                    }
                )
            elif isinstance(chunk, ToolResult):
                name = chunk.name
                if hasattr(name, "value"):
                    name = name.value
                # ToolResult.result can be arbitrary Python — fall
                # back to str() for non-JSON-serialisable values.
                try:
                    result_serialised = (
                        chunk.result if chunk.result is None else
                        json.loads(json.dumps(chunk.result, default=str))
                    )
                except (TypeError, ValueError):
                    result_serialised = str(chunk.result)
                emit(
                    {
                        "type": "tool_result",
                        "id": command_id,
                        "name": str(name),
                        "tool_id": chunk.id,
                        "result": result_serialised,
                        "error": chunk.error,
                    }
                )
    except asyncio.CancelledError:
        # `bridge.abort(turnId)` (TS handler firing on a turn-terminator
        # tool call) cancels this task. The model has already shipped
        # whatever was going to ship via MCP — we still want token
        # accounting for the chunks we did see, then re-raise so the
        # cancellation actually propagates.
        usage = await _extract_usage(response)
        emit({"type": "done", "id": command_id, "usage": usage})
        raise
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "type": "error",
                "id": command_id,
                "error": (
                    f"stream failed: {type(e).__name__}: {e}\n"
                    + traceback.format_exc()
                ),
            }
        )
        return

    usage = await _extract_usage(response)
    emit({"type": "done", "id": command_id, "usage": usage})


async def _extract_usage(response: Any) -> Any:
    """Pull token usage off the response. Returns the dict Talon
    expects (`prompt_token_count` etc.) or `None`.

    `ChatResponse.usage_metadata` is a `@property` returning
    `UsageMetadata | None` (read accumulated value, no I/O). The
    previous version of this code called it as a method —
    `response.usage_metadata()` — which raised `TypeError:
    'NoneType' object is not callable` when no usage was accumulated
    yet, and `TypeError: 'UsageMetadata' object is not callable`
    once usage existed. Either way the `except` swallowed it and
    every /status read showed 0/0/0/0/0%.
    """
    try:
        usage_obj = response.usage_metadata
        if usage_obj is None:
            return None
        return {
            "prompt_token_count": getattr(usage_obj, "prompt_token_count", None),
            "cached_content_token_count": getattr(
                usage_obj, "cached_content_token_count", None
            ),
            "candidates_token_count": getattr(
                usage_obj, "candidates_token_count", None
            ),
            "thoughts_token_count": getattr(
                usage_obj, "thoughts_token_count", None
            ),
            "total_token_count": getattr(usage_obj, "total_token_count", None),
        }
    except Exception:  # noqa: BLE001
        # Usage is best-effort; missing usage shouldn't fail the turn.
        return None


async def command_loop(agent) -> None:
    """Read JSON commands from stdin; dispatch each in a fresh task."""
    loop = asyncio.get_running_loop()
    # asyncio.StreamReader's default 64KB buffer rejects any line
    # longer than that with `LimitOverrunError: Separator is not
    # found, and chunk exceed the limit`. Talon's chat commands embed
    # the full system prompt + memory snapshot in the JSON payload,
    # which routinely exceeds 250KB once memory.md is non-trivial.
    # 16 MiB gives plenty of headroom and is what production async
    # JSON-RPC pipes typically use.
    reader = asyncio.StreamReader(limit=16 * 1024 * 1024, loop=loop)
    protocol = asyncio.StreamReaderProtocol(reader, loop=loop)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    in_flight: dict[str, asyncio.Task[Any]] = {}

    while True:
        line = await reader.readline()
        if not line:
            # EOF — parent closed stdin. Cancel any in-flight tasks,
            # then exit. The Agent.__aexit__ in main() will clean up
            # the localharness subprocess.
            for task in in_flight.values():
                task.cancel()
            break

        try:
            cmd = json.loads(line.decode("utf-8"))
        except json.JSONDecodeError as e:
            emit(
                {
                    "type": "error",
                    "id": None,
                    "error": f"invalid JSON command: {e}",
                }
            )
            continue

        cmd_type = cmd.get("type")
        cmd_id = cmd.get("id")

        if cmd_type == "shutdown":
            for task in in_flight.values():
                task.cancel()
            break

        if cmd_type == "abort":
            target = cmd.get("target")
            task = in_flight.get(target) if target else None
            if task is not None:
                task.cancel()
                emit(
                    {
                        "type": "aborted",
                        "id": cmd_id,
                        "target": target,
                    }
                )
            continue

        if cmd_type == "chat":
            prompt = cmd.get("prompt", "")
            if not cmd_id:
                emit(
                    {
                        "type": "error",
                        "id": None,
                        "error": "chat command missing 'id' field",
                    }
                )
                continue

            async def run_chat(prompt=prompt, cmd_id=cmd_id):
                # `stream_response` handles its own emit-on-cancellation
                # (with usage extracted), so we don't need a duplicate
                # `done` here — just pop the in-flight bookkeeping.
                try:
                    await stream_response(agent, cmd_id, prompt)
                finally:
                    in_flight.pop(cmd_id, None)

            in_flight[cmd_id] = asyncio.create_task(run_chat())
            continue

        emit(
            {
                "type": "error",
                "id": cmd_id,
                "error": f"unknown command type: {cmd_type!r}",
            }
        )


async def main_async(args: argparse.Namespace) -> int:
    try:
        cfg = read_config(args)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "id": None, "error": f"config: {e}"})
        return 2

    from google.antigravity import Agent

    # Connect MCP servers ourselves before building the agent config.
    # Soft-fail per server so one broken plugin (missing binary, bad
    # token, slow startup) doesn't take down the whole agent. The
    # surviving tools land in `mcp_mgr.tools`, which we hand to
    # LocalAgentConfig via `tools=[...]`.
    async with McpToolManager() as mcp_mgr:
        # Connect the frontend-tools MCP server (telegram-tools,
        # discord-tools, etc.) first so its `end_turn` / `send` /
        # `react` tools always fit under Gemini's 128-tool cap even if
        # the user has loaded a heavy plugin set. Plugins follow in
        # config order, and overflow tools are dropped with a log
        # entry so the operator knows what's missing.
        _FRONTEND_TOOLS = {
            "telegram-tools",
            "discord-tools",
            "teams-tools",
            "terminal-tools",
        }
        all_specs = list(cfg.get("mcp_servers", []))
        all_specs.sort(
            key=lambda s: 0 if s.get("name") in _FRONTEND_TOOLS else 1
        )
        for spec in all_specs:
            server_name = spec.get("name", "(unnamed)")
            try:
                added = await mcp_mgr.connect(spec)
                log("info", f"MCP connected: {server_name} ({added} tools)")
            except Exception as e:  # noqa: BLE001
                log(
                    "warn",
                    f"MCP server '{server_name}' failed to connect: "
                    f"{type(e).__name__}: {e} — skipping",
                )
                continue

        if mcp_mgr.dropped_summary:
            log("warn", mcp_mgr.dropped_summary)

        try:
            agent_config = build_agent_config(cfg, tools=mcp_mgr.tools)
        except Exception as e:  # noqa: BLE001
            emit(
                {
                    "type": "error",
                    "id": None,
                    "error": (
                        f"failed to build agent config: "
                        f"{type(e).__name__}: {e}\n"
                        + traceback.format_exc()
                    ),
                }
            )
            return 2

        try:
            async with Agent(agent_config) as agent:
                emit(
                    {
                        "type": "ready",
                        "protocol_version": BRIDGE_PROTOCOL_VERSION,
                        "conversation_id": agent.conversation_id,
                    }
                )
                await command_loop(agent)
        except BaseException as e:  # noqa: BLE001
            # The antigravity SDK wraps everything in nested anyio
            # TaskGroups, so a real exception ends up at depth >10 in
            # a BaseExceptionGroup and Python's default formatter
            # prints `... (max_group_depth is 10)` instead of the
            # actual cause. Walk the tree by hand for the leaves.
            def _flatten(exc: BaseException, depth: int = 0) -> list[str]:
                out: list[str] = []
                indent = "  " * depth
                out.append(f"{indent}{type(exc).__name__}: {exc}")
                if isinstance(exc, BaseExceptionGroup):
                    for sub in exc.exceptions:
                        out.extend(_flatten(sub, depth + 1))
                if exc.__cause__ is not None:
                    out.append(f"{indent}  caused by:")
                    out.extend(_flatten(exc.__cause__, depth + 2))
                if (
                    exc.__context__ is not None
                    and exc.__context__ is not exc.__cause__
                ):
                    out.append(f"{indent}  during handling of:")
                    out.extend(_flatten(exc.__context__, depth + 2))
                return out

            leaves = "\n".join(_flatten(e))
            emit(
                {
                    "type": "error",
                    "id": None,
                    "error": (
                        f"agent lifecycle error: "
                        f"{type(e).__name__}: {e}\n"
                        f"--- flattened tree ---\n{leaves}\n"
                        f"--- traceback ---\n"
                        + traceback.format_exc()
                    ),
                }
            )
            return 1

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-fd",
        type=int,
        default=3,
        help="File descriptor carrying the JSON config payload",
    )
    parser.add_argument(
        "--config-stdin",
        action="store_true",
        help=(
            "Read JSON config from the first stdin line "
            "(for interactive testing without an fd handoff)"
        ),
    )
    args = parser.parse_args()

    try:
        return asyncio.run(main_async(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
