/**
 * AntigravityBridge tests — drive the subprocess against a fake bridge
 * implementation that mimics the agent_bridge.py JSONL protocol but
 * doesn't require google-antigravity / Python.
 *
 * The fake bridge is a small Node script we spawn instead of python3.
 * It speaks the exact same wire protocol (read JSON config from fd 3,
 * write JSONL events to stdout, read JSONL commands from stdin), so
 * the TS-side bridge code runs through the real spawn / IPC path.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AntigravityBridge } from "../backend/antigravity/python-bridge.js";

const fakeBridgeScript = `#!/usr/bin/env node
// Fake agent_bridge.py — speaks the same JSONL protocol over stdin/stdout
// and reads its config from fd 3, but doesn't require any Python deps.

const fs = require("node:fs");
const readline = require("node:readline");

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function readConfig() {
  try {
    const buf = fs.readFileSync(3);
    return JSON.parse(buf.toString("utf-8"));
  } catch (e) {
    emit({ type: "error", id: null, error: "config read failed: " + e.message });
    process.exit(2);
  }
}

const config = readConfig();
emit({
  type: "ready",
  protocol_version: 1,
  conversation_id: "fake-conv-" + Date.now(),
});

const rl = readline.createInterface({ input: process.stdin });
const scripts = new Map();

// Test mode controlled by env: scripts how each chat id should respond.
//   echo:    emit text "echo:<prompt>" + done
//   tools:   emit a tool_call (mcp__telegram-tools__end_turn) then done
//   error:   emit an error event
//   timeout: never respond
const mode = process.env.FAKE_BRIDGE_MODE || "echo";

rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }
  if (cmd.type === "shutdown") {
    process.exit(0);
  }
  if (cmd.type === "abort") {
    emit({ type: "aborted", id: cmd.id, target: cmd.target });
    return;
  }
  if (cmd.type !== "chat") return;

  if (mode === "echo") {
    emit({ type: "text", id: cmd.id, text: "echo:" + cmd.prompt.slice(0, 30), step_index: 0 });
    emit({
      type: "done",
      id: cmd.id,
      usage: {
        prompt_token_count: 42,
        cached_content_token_count: 0,
        candidates_token_count: 7,
        thoughts_token_count: 0,
        total_token_count: 49,
      },
    });
  } else if (mode === "tools") {
    emit({
      type: "tool_call",
      id: cmd.id,
      name: "mcp__telegram-tools__end_turn",
      args: { text: "hi" },
      tool_id: "tc-1",
    });
    emit({
      type: "tool_result",
      id: cmd.id,
      name: "mcp__telegram-tools__end_turn",
      tool_id: "tc-1",
      result: { ok: true },
      error: null,
    });
    emit({
      type: "done",
      id: cmd.id,
      usage: { prompt_token_count: 10, total_token_count: 10 },
    });
  } else if (mode === "error") {
    emit({ type: "error", id: cmd.id, error: "scripted failure" });
  } else if (mode === "timeout") {
    // emit nothing — caller will time out
  }
});
`;

let bridgeScriptPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "ag-bridge-test-"));
  bridgeScriptPath = join(dir, "fake-agent-bridge.js");
  writeFileSync(bridgeScriptPath, fakeBridgeScript);
  chmodSync(bridgeScriptPath, 0o755);
});

describe("AntigravityBridge — happy path", () => {
  it("reaches ready after start()", async () => {
    const bridge = new AntigravityBridge("chat-happy", {
      turnTimeoutMs: 5_000,
    });
    try {
      await bridge.start(
        {
          gemini_api_key: "fake",
          model: "gemini-3.5-flash",
          workspaces: ["/tmp/ag-test"],
          mcp_servers: [],
        },
        {
          pythonPath: process.execPath, // node binary
          bridgeScriptPath,
        },
      );
      expect(bridge.isReady()).toBe(true);
    } finally {
      await bridge.shutdown();
    }
  });

  it("relays a turn's text + usage", async () => {
    const bridge = new AntigravityBridge("chat-echo", { turnTimeoutMs: 5_000 });
    try {
      await bridge.start(
        { gemini_api_key: "fake", workspaces: ["/tmp/ag-test"] },
        { pythonPath: process.execPath, bridgeScriptPath },
      );

      const textParts: string[] = [];
      const result = await bridge.chat({
        id: "turn-echo",
        prompt: "hello world",
        onText: (delta) => textParts.push(delta),
      });

      expect(result.text).toContain("echo:hello world");
      expect(textParts.join("")).toContain("echo:hello world");
      expect(result.usage?.prompt_token_count).toBe(42);
      expect(result.usage?.total_token_count).toBe(49);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe("AntigravityBridge — tool calls", () => {
  it("surfaces ToolCall + ToolResult events to onToolCall", async () => {
    const bridge = new AntigravityBridge("chat-tools", {
      turnTimeoutMs: 5_000,
    });
    try {
      await bridge.start(
        { gemini_api_key: "fake", workspaces: ["/tmp/ag-test"] },
        {
          pythonPath: process.execPath,
          bridgeScriptPath,
        },
      );

      // Re-spawn with FAKE_BRIDGE_MODE=tools. Easier: env on the
      // worker via NODE env. The current python-bridge.ts inherits
      // process.env so set it before chat() — actually we need to
      // re-spawn with the env. For simplicity, set process.env here.
      process.env.FAKE_BRIDGE_MODE = "tools";
    } finally {
      await bridge.shutdown();
    }

    // Now restart with tools mode env (set above).
    const bridge2 = new AntigravityBridge("chat-tools-2", {
      turnTimeoutMs: 5_000,
    });
    try {
      await bridge2.start(
        { gemini_api_key: "fake", workspaces: ["/tmp/ag-test"] },
        { pythonPath: process.execPath, bridgeScriptPath },
      );

      const toolCalls: Array<{ name: string; args: Record<string, unknown> }> =
        [];
      const result = await bridge2.chat({
        id: "turn-tool",
        prompt: "use a tool",
        onToolCall: (name, args) => toolCalls.push({ name, args }),
      });

      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].name).toBe("mcp__telegram-tools__end_turn");
      expect(toolCalls[0].args).toEqual({ text: "hi" });
      expect(result.toolResults.length).toBe(1);
      expect(result.toolResults[0].result).toEqual({ ok: true });
    } finally {
      await bridge2.shutdown();
      delete process.env.FAKE_BRIDGE_MODE;
    }
  });
});

describe("AntigravityBridge — error path", () => {
  it("rejects chat() when the bridge emits an error event", async () => {
    process.env.FAKE_BRIDGE_MODE = "error";
    const bridge = new AntigravityBridge("chat-error", {
      turnTimeoutMs: 5_000,
    });
    try {
      await bridge.start(
        { gemini_api_key: "fake", workspaces: ["/tmp/ag-test"] },
        { pythonPath: process.execPath, bridgeScriptPath },
      );

      await expect(
        bridge.chat({ id: "turn-fail", prompt: "boom" }),
      ).rejects.toThrow(/scripted failure/);
    } finally {
      await bridge.shutdown();
      delete process.env.FAKE_BRIDGE_MODE;
    }
  });
});

describe("AntigravityBridge — timeout", () => {
  it("rejects chat() after the configured timeout", async () => {
    process.env.FAKE_BRIDGE_MODE = "timeout";
    const bridge = new AntigravityBridge("chat-timeout", {
      turnTimeoutMs: 500,
    });
    try {
      await bridge.start(
        { gemini_api_key: "fake", workspaces: ["/tmp/ag-test"] },
        { pythonPath: process.execPath, bridgeScriptPath },
      );

      await expect(
        bridge.chat({ id: "turn-slow", prompt: "slow" }),
      ).rejects.toThrow(/timed out/);
    } finally {
      await bridge.shutdown();
      delete process.env.FAKE_BRIDGE_MODE;
    }
  });
});

describe("AntigravityBridge — protocol mismatch", () => {
  it("rejects start when the bridge advertises a wrong protocol version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-bridge-bad-"));
    const badScript = join(dir, "bad-bridge.js");
    writeFileSync(
      badScript,
      `#!/usr/bin/env node
const fs = require("node:fs");
try { fs.readFileSync(3); } catch (e) {}
process.stdout.write(JSON.stringify({type:"ready", protocol_version: 999}) + "\\n");
`,
    );
    chmodSync(badScript, 0o755);

    const bridge = new AntigravityBridge("chat-protocol", {
      turnTimeoutMs: 5_000,
    });
    await expect(
      bridge.start(
        { gemini_api_key: "fake", workspaces: ["/tmp/ag-test"] },
        { pythonPath: process.execPath, bridgeScriptPath: badScript },
      ),
    ).rejects.toThrow(/protocol version mismatch/);
    await bridge.shutdown();
  });
});
