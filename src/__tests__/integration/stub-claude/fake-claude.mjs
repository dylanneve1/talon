#!/usr/bin/env node
/**
 * Stub claude CLI — replaces the real `claude` binary in integration tests.
 *
 * The Claude Agent SDK communicates with the `claude` CLI via streaming JSONL
 * over stdin/stdout (`--input-format stream-json --output-format stream-json`).
 * This script implements just enough of the protocol to drive the SDK through
 * a scripted conversation so we can write integration tests for our handler,
 * options, hooks, and stream processing without hitting the live API.
 *
 * The script to run is provided via `STUB_CLAUDE_SCRIPT` (path to JSON file)
 * or `STUB_CLAUDE_SCRIPT_INLINE` (inline JSON). Schema is described in
 * `protocol.ts`.
 *
 * Protocol summary (reverse-engineered from real SDK invocations):
 *
 *   SDK → binary (stdin):
 *     1. {type: "control_request", request: {subtype: "initialize", ...}}
 *     2. {type: "user", message: {role, content}, parent_tool_use_id, ...}
 *     3. (after tool_use blocks dispatch) {type: "user", message: {role: "user",
 *        content: [{type: "tool_result", tool_use_id, content}]}, ...}
 *
 *   binary → SDK (stdout):
 *     1. {type: "control_response", response: {subtype: "success", request_id,
 *        response: SDKControlInitializeResponse}}
 *     2. {type: "system", subtype: "init", session_id, ...}
 *     3. {type: "assistant", message: {content: [...]}, session_id, ...}
 *     4. {type: "result", subtype: "success"|"error_during_execution"|...}
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const LOG_FILE = process.env.STUB_CLAUDE_LOG;
const log = (msg) => {
  if (LOG_FILE) appendFileSync(LOG_FILE, msg + "\n");
};

// ── Load script ──────────────────────────────────────────────────────────────

const loadScript = () => {
  if (process.env.STUB_CLAUDE_SCRIPT_INLINE) {
    return JSON.parse(process.env.STUB_CLAUDE_SCRIPT_INLINE);
  }
  const path = process.env.STUB_CLAUDE_SCRIPT;
  if (!path || !existsSync(path)) {
    // No script provided — degrade gracefully. Used for SDK model-discovery
    // boots and other "init only, never receive user messages" flows.
    log(
      `no script provided (path=${path ?? "unset"}), running in init-only mode`,
    );
    return { turns: [] };
  }
  return JSON.parse(readFileSync(path, "utf8"));
};

const SCRIPT = loadScript();
const SESSION_ID =
  SCRIPT.sessionId ?? "stub-session-" + randomUUID().slice(0, 8);

// ── Output helpers ──────────────────────────────────────────────────────────

const send = (obj) => {
  const line = JSON.stringify(obj);
  log("STDOUT: " + line);
  process.stdout.write(line + "\n");
};

const defaultInitResponse = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  // ModelInfo schema (per SDK's sdk.d.ts) is { value, displayName, description }.
  models: [
    {
      value: "claude-sonnet-4-6",
      displayName: "Sonnet 4.6 (stub)",
      description: "Stub model for integration tests",
    },
    {
      value: "default",
      displayName: "Default (stub)",
      description: "Stub model for integration tests",
    },
  ],
  account: { email: "stub@stub.test", organization: { name: "stub-org" } },
};

const defaultSystemInit = {
  type: "system",
  subtype: "init",
  session_id: SESSION_ID,
  cwd: process.cwd(),
  tools: [],
  mcp_servers: [],
  model: "claude-sonnet-4-6",
  permissionMode: "bypassPermissions",
  slash_commands: [],
  apiKeySource: "none",
};

// ── State ────────────────────────────────────────────────────────────────────

let turnIndex = 0;
/** Map from request_id we emitted -> resolver waiting on the SDK's response. */
const pendingRequests = new Map();
/** When set, the init handshake has captured these hook callback ids by event. */
let hookCallbackIds = {};

// ── Message handlers ────────────────────────────────────────────────────────

const handleInitialize = (msg) => {
  // Capture hook callback ids — needed if the stub fires hooks during a turn.
  const hooks = msg.request?.hooks ?? {};
  hookCallbackIds = {};
  for (const [event, matchers] of Object.entries(hooks)) {
    hookCallbackIds[event] = matchers.flatMap((m) => m.hookCallbackIds ?? []);
  }
  log("CAPTURED hookCallbackIds: " + JSON.stringify(hookCallbackIds));
  const initResponse = SCRIPT.initResponse ?? defaultInitResponse;
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: msg.request_id,
      response: initResponse,
    },
  });
  send(SCRIPT.systemInit ?? defaultSystemInit);
};

/** Send a control_request to the SDK and resolve with its control_response payload. */
const sendControlRequest = (request) => {
  const requestId = "stub_req_" + randomUUID().slice(0, 8);
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    send({ type: "control_request", request_id: requestId, request });
    // Per-call timeout in case SDK never responds
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(
          new Error("control_request timeout: " + JSON.stringify(request)),
        );
      }
    }, 5000).unref();
  });
};

const handleUser = async (_msg) => {
  // Pop the next scripted turn and emit its messages
  const turn = SCRIPT.turns?.[turnIndex];
  turnIndex += 1;
  if (!turn) {
    // No more scripted turns — emit a benign result and exit
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "stub: out of script",
      duration_ms: 1,
      duration_api_ms: 0,
      num_turns: turnIndex,
      session_id: SESSION_ID,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    return;
  }
  for (const out of turn.emit ?? []) {
    if (out.type === "_fire_hook") {
      // Synthesize a hook_callback control_request to the SDK. The SDK calls
      // the registered hook function and replies with the hook output. If the
      // hook returns continue:false, we stop emitting subsequent items.
      const callbackIds = hookCallbackIds[out.event] ?? [];
      if (!callbackIds.length) {
        log(`no hook registered for event ${out.event}, skipping`);
        continue;
      }
      let stopped = false;
      for (const callbackId of callbackIds) {
        try {
          const resp = await sendControlRequest({
            subtype: "hook_callback",
            callback_id: callbackId,
            input: out.input,
            tool_use_id: out.tool_use_id,
          });
          log("hook response: " + JSON.stringify(resp));
          if (resp?.response?.continue === false) {
            stopped = true;
            break;
          }
        } catch (e) {
          log("hook fire error: " + e.message);
        }
      }
      if (stopped) {
        log("hook returned continue:false, halting emit loop");
        // Emit a result indicating hook-driven termination so the SDK iterator
        // closes cleanly.
        send({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "stub: hook stopped",
          duration_ms: 1,
          duration_api_ms: 0,
          num_turns: turnIndex,
          session_id: SESSION_ID,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
        return;
      }
      continue;
    }
    const filled = fillDefaults(out);
    send(filled);
  }
};

const fillDefaults = (out) => {
  if (out.type === "assistant") {
    return {
      type: "assistant",
      message: {
        id: "msg_" + randomUUID().slice(0, 8),
        type: "message",
        role: "assistant",
        model: out.message?.model ?? "claude-sonnet-4-6",
        content: out.message?.content ?? [],
        stop_reason: out.message?.stop_reason ?? "end_turn",
        stop_sequence: out.message?.stop_sequence ?? null,
        usage: out.message?.usage ?? {
          input_tokens: 1,
          output_tokens: 1,
        },
      },
      session_id: SESSION_ID,
      parent_tool_use_id: out.parent_tool_use_id ?? null,
    };
  }
  if (out.type === "result") {
    // Talon's stream.ts reads token usage from `modelUsage[sdkModel]`. Build a
    // matching shape from `usage` if the test didn't provide modelUsage explicitly.
    const usage = out.usage ?? { input_tokens: 0, output_tokens: 0 };
    const defaultModelUsage = {
      "claude-sonnet-4-6": {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 200_000,
      },
    };
    return {
      type: "result",
      subtype: out.subtype ?? "success",
      is_error: out.is_error ?? false,
      result: out.result ?? "",
      duration_ms: out.duration_ms ?? 1,
      duration_api_ms: out.duration_api_ms ?? 0,
      num_turns: out.num_turns ?? turnIndex,
      session_id: SESSION_ID,
      total_cost_usd: out.total_cost_usd ?? 0,
      usage,
      modelUsage: out.modelUsage ?? defaultModelUsage,
    };
  }
  return out;
};

// ── Stdin loop ──────────────────────────────────────────────────────────────

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    log("STDIN: " + line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log("STDIN parse error on: " + line);
      continue;
    }
    if (
      msg.type === "control_request" &&
      msg.request?.subtype === "initialize"
    ) {
      handleInitialize(msg);
    } else if (msg.type === "user") {
      handleUser(msg).catch((e) => log("handleUser error: " + e.message));
    } else if (msg.type === "control_response") {
      // Response to a control_request the stub previously sent (e.g. a fired
      // hook). Resolve the pending promise.
      const requestId = msg.response?.request_id;
      const pending = pendingRequests.get(requestId);
      if (pending) {
        pendingRequests.delete(requestId);
        pending.resolve(msg);
      }
    } else if (msg.type === "control_request") {
      // Ack other control requests with empty success so the SDK doesn't hang
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: {},
        },
      });
    }
  }
});

process.stdin.on("end", () => {
  log("STDIN ENDED");
  // Give pending stdout writes time to flush, then exit
  setTimeout(() => process.exit(0), 50);
});

// Safety: hard timeout so a misbehaving test doesn't hang CI
const HARD_TIMEOUT_MS = Number(process.env.STUB_CLAUDE_TIMEOUT_MS ?? 10000);
setTimeout(() => {
  log(`HARD TIMEOUT after ${HARD_TIMEOUT_MS}ms`);
  process.exit(2);
}, HARD_TIMEOUT_MS).unref();
