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


# ── MCP tool-name de-collision patches ──────────────────────────────────────
#
# The antigravity Python SDK aggregates MCP tools via the `mcp` client's
# `ClientSessionGroup` but never installs a `component_name_hook`, so two
# servers exposing tools with the same name (Talon has `cancel_scheduled`
# on both `telegram-tools` and the `email` plugin) trip a duplicate-key
# guard in `_aggregate_components` and the Agent context manager dies.
#
# Even after installing a name hook, `google.antigravity.mcp.bridge.
# get_mcp_tools` reads `tool_info.name` (the raw tool name from the
# server) instead of the dict key the hook produced, which means the
# returned wrappers all share the original colliding name and the
# subsequent `session_group.call_tool(<raw name>)` dispatch fails with
# a KeyError on `_tool_to_session`.
#
# We patch both: install a `mcp_<server>__<tool>` hook (matching the
# convention claude-sdk and openai-agents already use) AND rewrite
# `get_mcp_tools` to use the dict key as the wrapper name + dispatch
# argument. Net effect: each plugin's tools coexist under unique
# names; `session_group.call_tool(hooked)` finds the session; the
# session then calls the underlying MCP server with the unhooked
# `tool.name`, which is what the server expects on the wire.


def _install_mcp_collision_patches() -> None:
    import mcp.client.session_group as _session_group_mod
    from google.antigravity.mcp import bridge as _ag_bridge
    from google.antigravity.tools.tool_runner import ToolWithSchema

    def _name_hook(name: str, server_info: Any) -> str:
        server_name = getattr(server_info, "name", None) or "mcp"
        return f"mcp_{server_name}__{name}"

    orig_init = _session_group_mod.ClientSessionGroup.__init__

    def _patched_init(
        self: Any,
        exit_stack: Any = None,
        component_name_hook: Any = None,
    ) -> None:
        # Don't clobber a caller-supplied hook — they're explicitly
        # opting into their own naming scheme.
        if component_name_hook is None:
            component_name_hook = _name_hook
        orig_init(
            self,
            exit_stack=exit_stack,
            component_name_hook=component_name_hook,
        )

    _session_group_mod.ClientSessionGroup.__init__ = _patched_init

    async def _patched_get_mcp_tools(session_group: Any) -> Any:
        tools = []
        # Iterate items() so we pick up the hooked KEY (e.g.
        # `mcp_email-tools__cancel_scheduled`) rather than
        # `tool_info.name` (the raw `cancel_scheduled`).
        for hooked_name, tool_info in session_group.tools.items():

            def make_wrapper(tool_name: str, doc: str | None) -> Any:
                async def wrapper(**kwargs: Any) -> Any:
                    return await session_group.call_tool(tool_name, kwargs)

                wrapper.__name__ = tool_name
                if doc:
                    wrapper.__doc__ = doc
                return wrapper

            wrapper_fn = make_wrapper(hooked_name, tool_info.description)
            tools.append(ToolWithSchema(wrapper_fn, tool_info.inputSchema))
        return tools

    _ag_bridge.get_mcp_tools = _patched_get_mcp_tools


_install_mcp_collision_patches()


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


def build_agent_config(cfg: dict[str, Any]):
    """Translate Talon's JSON config into a LocalAgentConfig."""
    # Imports are inside the function so a missing dependency surfaces
    # as a clean `error` event with a useful message instead of an
    # import-time crash before the bridge has a chance to emit.
    from google.antigravity import (
        CapabilitiesConfig,
        GeminiConfig,
        LocalAgentConfig,
    )
    from google.antigravity.types import McpStdioServer

    api_key = cfg.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        log(
            "warn",
            "No Gemini API key provided — first model call will fail "
            "with 'API key not valid'. Set geminiApiKey in talon.json "
            "or GEMINI_API_KEY in env to enable.",
        )

    model = cfg.get("model")

    # Build MCP servers (frontend tools + plugins).
    #
    # The antigravity SDK's `McpStdioServer` model only defines
    # `command` / `args` — no `env` field — and the underlying
    # `StdioServerParameters(command=..., args=...)` call drops env
    # entirely. Talon's `telegram-tools` MCP server needs
    # `TALON_CHAT_ID` / `TALON_FRONTEND` / `TALON_BRIDGE_URL` to
    # function, so we bake those into the command itself via
    # `/usr/bin/env KEY=VAL …` (POSIX). The launcher inherits stdin
    # / stdout from us through the SDK either way.
    mcp_servers: list[McpStdioServer] = []
    for spec in cfg.get("mcp_servers", []):
        spec_env = spec.get("env") or {}
        spec_cmd = spec["command"]
        spec_args = list(spec.get("args", []))
        if spec_env:
            env_kv = [f"{k}={v}" for k, v in spec_env.items()]
            wrapped_cmd = "/usr/bin/env"
            wrapped_args = [*env_kv, spec_cmd, *spec_args]
        else:
            wrapped_cmd = spec_cmd
            wrapped_args = spec_args
        mcp_servers.append(
            McpStdioServer(
                name=spec["name"],
                command=wrapped_cmd,
                args=wrapped_args,
            )
        )

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
        # Default: full caps. Talon expects the agent to operate as
        # an autonomous chat partner, not a sandboxed read-only viewer.
        capabilities = CapabilitiesConfig()
    elif capabilities_raw is False:
        # Talon explicitly asked for read-only.
        capabilities = None  # LocalAgentConfig default is read-only
    else:
        capabilities = CapabilitiesConfig()

    save_dir = cfg.get("save_dir")
    app_data_dir = cfg.get("app_data_dir")
    system_instructions = cfg.get("system_instructions")

    kwargs: dict[str, Any] = {
        "gemini_config": GeminiConfig(api_key=api_key),
        "mcp_servers": mcp_servers,
        "workspaces": workspaces,
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

    usage = None
    try:
        usage_obj = response.usage_metadata()
        if asyncio.iscoroutine(usage_obj):
            usage_obj = await usage_obj
        if usage_obj is not None:
            usage = {
                "prompt_token_count": getattr(
                    usage_obj, "prompt_token_count", None
                ),
                "cached_content_token_count": getattr(
                    usage_obj, "cached_content_token_count", None
                ),
                "candidates_token_count": getattr(
                    usage_obj, "candidates_token_count", None
                ),
                "thoughts_token_count": getattr(
                    usage_obj, "thoughts_token_count", None
                ),
                "total_token_count": getattr(
                    usage_obj, "total_token_count", None
                ),
            }
    except Exception:  # noqa: BLE001
        # Usage is best-effort; missing usage shouldn't fail the turn.
        usage = None

    emit({"type": "done", "id": command_id, "usage": usage})


async def command_loop(agent) -> None:
    """Read JSON commands from stdin; dispatch each in a fresh task."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(loop=loop)
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

    try:
        agent_config = build_agent_config(cfg)
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

    from google.antigravity import Agent

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
    except Exception as e:  # noqa: BLE001
        emit(
            {
                "type": "error",
                "id": None,
                "error": (
                    f"agent lifecycle error: "
                    f"{type(e).__name__}: {e}\n"
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
