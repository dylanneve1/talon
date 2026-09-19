/**
 * Antigravity process-layer tests: argv construction, turn
 * serialisation, the kill ladder, the pool's reuse/respawn rules, and
 * the session lifecycle built on top of them.
 */

import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const spawned: Array<{ args: string[] }> = [];
let children: FakeChild[] = [];
let autoResult = true;

class FakeStream extends EventEmitter {
  setEncoding(): void {}
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  signals: string[] = [];
  killed = false;
  prompts: string[] = [];
  stdin = {
    write: (line: string, cb?: (e?: Error) => void) => {
      this.prompts.push(line);
      cb?.();
      if (autoResult) {
        queueMicrotask(() => {
          if (this.killed) return;
          this.stdout.emit(
            "data",
            `${JSON.stringify({
              event: "result",
              result: {
                conversation_id: "conv-x",
                status: "SUCCESS",
                response: "ok",
              },
            })}\n`,
          );
        });
      }
      return true;
    },
    end: () => {},
  };
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (!this.killed) {
      this.killed = true;
      queueMicrotask(() => this.emit("close", 0));
    }
    return true;
  }
}

vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      spawned.push({ args });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});
vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
  getPluginPromptAdditions: vi.fn(() => []),
}));

const {
  buildAgyArgs,
  ensureChild,
  getChild,
  killAllChildren,
  childChatIds,
  AgyTurnAborted,
} = await import("../backend/agy/process/child.js");
const { resetChat, warmSession, refreshTools } =
  await import("../backend/agy/sessions.js");
const { initAgyAgent } = await import("../backend/agy/init.js");
const { resetState, getState } = await import("../backend/agy/state.js");
const { resetOwnership } = await import("../backend/agy/mcp/register.js");
const { resetModelCache } = await import("../backend/agy/models.js");
const sessions = await import("../storage/sessions.js");

let home: string;
let configPath: string;
const CHAT = "-100proc";

const spec = (over: Record<string, unknown> = {}) => ({
  binary: "/fake/agy",
  cwd: "/tmp",
  model: "gemini-3.8-flash-high",
  addDirs: ["/tmp"],
  ...over,
});

/**
 * Sink the MCP-config env points at between tests, so nothing can ever
 * fall back to the real `~/.gemini/config/mcp_config.json`.
 */
const SINK = mkdtempSync(join(tmpdir(), "agy-sink-"));
process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agy-proc-"));
  mkdirSync(join(home, "config"), { recursive: true });
  configPath = join(home, "config", "mcp_config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  process.env.TALON_AGY_MCP_CONFIG = configPath;
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(home, "snapshots");
  spawned.length = 0;
  children = [];
  autoResult = true;
  killAllChildren("test");
  resetState();
  resetModelCache();
  resetOwnership();
  sessions.resetSession(CHAT);
  initAgyAgent(
    {
      model: "gemini-3.8-flash-high",
      workspace: home,
      systemPrompt: "x",
      frontend: "telegram",
      agyBinary: "/fake/agy",
    } as never,
    () => 19876,
    "telegram",
  );
});

afterEach(() => {
  // Never unset the injection env: a late async write (a retry ladder
  // resolving after the test returned) would otherwise land in the
  // developer's REAL ~/.gemini/config/mcp_config.json. Point it at a
  // per-file sink instead.
  process.env.TALON_AGY_MCP_CONFIG = join(SINK, "mcp_config.json");
  process.env.TALON_AGY_MCP_SNAPSHOT_DIR = join(SINK, "snapshots");
  killAllChildren("test");
  rmSync(home, { recursive: true, force: true });
});

describe("agy process — argv", () => {
  it("always carries the four headless flags, in order", () => {
    expect(buildAgyArgs(spec())).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "0s",
      "--model",
      "gemini-3.8-flash-high",
      "--add-dir",
      "/tmp",
    ]);
  });

  it("adds --effort and --conversation only when asked", () => {
    const args = buildAgyArgs(spec({ effort: "high", conversationId: "abc" }));
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--conversation") + 1]).toBe("abc");
  });
});

describe("agy process — turn lifecycle", () => {
  it("writes exactly one user event per turn and resolves on its result", async () => {
    const child = ensureChild(CHAT, spec());
    const result = await child.runTurn("hello");
    expect(result.status).toBe("SUCCESS");
    expect(children[0].prompts).toHaveLength(1);
    expect(JSON.parse(children[0].prompts[0])).toEqual({
      event: "user",
      message: { content: "hello" },
    });
    expect(child.conversationId).toBe("conv-x");
  });

  it("rejects a second concurrent turn instead of silently queueing", async () => {
    autoResult = false;
    const child = ensureChild(CHAT, spec());
    const first = child.runTurn("one");
    await expect(child.runTurn("two")).rejects.toThrow(/already in flight/);
    child.kill("cleanup");
    await expect(first).rejects.toBeInstanceOf(AgyTurnAborted);
  });

  it("rejects the in-flight turn with AgyTurnAborted when killed", async () => {
    autoResult = false;
    const child = ensureChild(CHAT, spec());
    const turn = child.runTurn("one");
    child.kill("terminator");
    const err = await turn.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgyTurnAborted);
    // The word "abort" is what every backend's clean-close check keys on.
    expect(String(err)).toMatch(/abort/i);
    expect(String(err)).toContain("terminator");
  });

  it("surfaces the child dying mid-turn with its stderr tail", async () => {
    autoResult = false;
    const child = ensureChild(CHAT, spec());
    const turn = child.runTurn("one");
    children[0].stderr.emit("data", "fatal: kaboom\n");
    children[0].emit("close", 2);
    await expect(turn).rejects.toThrow(/kaboom/);
  });

  it("ends stdin and escalates SIGTERM before SIGKILL", async () => {
    const child = ensureChild(CHAT, spec());
    await child.runTurn("hi");
    child.kill("reset");
    expect(children[0].signals[0]).toBe("SIGTERM");
    expect(child.alive).toBe(false);
  });

  it("reaps an idle child", async () => {
    vi.useFakeTimers();
    try {
      const child = ensureChild(CHAT, spec({ idleMs: 1000 }));
      await child.runTurn("hi");
      expect(child.alive).toBe(true);
      vi.advanceTimersByTime(1500);
      expect(child.alive).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agy process — the pool", () => {
  it("reuses a live child with the same spec", () => {
    const a = ensureChild(CHAT, spec());
    const b = ensureChild(CHAT, spec());
    expect(a).toBe(b);
    expect(spawned).toHaveLength(1);
  });

  it("respawns on a model change and carries the conversation across", async () => {
    const a = ensureChild(CHAT, spec());
    await a.runTurn("hi");
    const b = ensureChild(CHAT, spec({ model: "gemini-3.1-pro-high" }));
    expect(b).not.toBe(a);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toContain("--conversation");
    expect(spawned[1].args[spawned[1].args.indexOf("--conversation") + 1]).toBe(
      "conv-x",
    );
  });

  it("killAllChildren empties the pool", () => {
    ensureChild("a", spec());
    ensureChild("b", spec());
    expect(childChatIds().sort()).toEqual(["a", "b"]);
    killAllChildren("shutdown");
    expect(childChatIds()).toEqual([]);
  });
});

describe("agy sessions", () => {
  const servers = () =>
    Object.keys(
      (
        JSON.parse(readFileSync(configPath, "utf-8")) as {
          mcpServers: Record<string, unknown>;
        }
      ).mcpServers,
    );

  it("warmSession pre-spawns the child and registers its MCP entries", async () => {
    await warmSession(CHAT);
    expect(spawned).toHaveLength(1);
    expect(servers().some((k) => k.startsWith("__talon__"))).toBe(true);
    expect(getChild(CHAT)?.alive).toBe(true);
  });

  it("warmSession never throws when there is no config", async () => {
    resetState();
    await expect(warmSession(CHAT)).resolves.toBeUndefined();
  });

  it("resetChat kills the child, drops the MCP entries and the usage", async () => {
    await warmSession(CHAT);
    getState().lastUsage.set(CHAT, {
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    resetChat(CHAT);
    expect(getChild(CHAT)).toBeUndefined();
    expect(servers()).toEqual([]);
    expect(getState().lastUsage.get(CHAT)).toBeUndefined();
  });

  it("refreshTools rewrites the entries and drops the child so it respawns", async () => {
    await warmSession(CHAT);
    const diff = await refreshTools(CHAT);
    expect(diff.errors).toEqual({});
    expect(getChild(CHAT)).toBeUndefined();
    expect(servers().some((k) => k.startsWith("__talon__"))).toBe(true);
  });
});
