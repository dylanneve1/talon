/**
 * Real-bootstrap integration test for the OpenCode backend.
 *
 * Mirror of `kilo-real-bootstrap.test.ts` — same shape, same isolation
 * strategy, same proof. Calls Talon's production `bootstrap()` +
 * `initBackendAndDispatcher()` against a real `opencode serve` so any
 * regression in the OpenCode-specific MCP-isolation / permission-ruleset /
 * cache-invalidation paths gets caught.
 *
 * Test-side fakes (identical rationale to the kilo test):
 *   1. `vi.mock("../../util/paths.js")` — isolated tempdir for $HOME.
 *   2. `vi.hoisted(() => process.env.OPENCODE_PORT = ...)` — points the
 *      production `OPENCODE_PORT` const at our test port.
 *   3. Pre-spawned `opencode serve` with `cwd` + `HOME` + `XDG_*`
 *      isolation so it can't read prod opencode's persisted MCP catalog
 *      or session state.
 *   4. Minimal `Frontend` object wired to a Gateway + RecordingHandler.
 *
 * Skipping: gated behind the `opencode` CLI being on PATH (or
 * OPENCODE_EXECUTABLE pointing at it). CI sets OPENCODE_LIVE_REQUIRED=1.
 */

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  cliAvailable,
  cliCommand,
  stopProcess,
  waitForHealthy,
} from "./live-backend-helpers.js";
import { Gateway } from "../../core/gateway.js";
import { makeRecordingHandler } from "./recording-handler.js";
import type { Frontend } from "../../bootstrap.js";
import type { ContextManager } from "../../core/types.js";

// ── Preflight gating ───────────────────────────────────────────────────────

const OPENCODE_EXECUTABLE_ENV = "OPENCODE_EXECUTABLE";
const OPENCODE_PRESENT = cliAvailable("opencode", OPENCODE_EXECUTABLE_ENV);
const OPENCODE_REQUIRED = process.env.OPENCODE_LIVE_REQUIRED === "1";
const opencodeDescribe =
  OPENCODE_PRESENT || OPENCODE_REQUIRED ? describe : describe.skip;

// 4096 = prod opencode, 4097 = prod kilo, 4197 = opencode-live,
// 4198 = kilo-live, 4199 = kilo-real-bootstrap.
const TEST_PORT = vi.hoisted(() => {
  const port = String(process.env.OPENCODE_REAL_BOOTSTRAP_PORT ?? "4196");
  process.env.OPENCODE_PORT = port;
  return Number(port);
});

const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const HEALTH_TIMEOUT_MS = process.platform === "win32" ? 60_000 : 30_000;

// ── vi.mock: paths.js → isolated tempdir ───────────────────────────────────

vi.mock("../../util/paths.js", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const TALON_ROOT = fs.mkdtempSync(
    path.resolve(os.tmpdir(), "talon-opencode-bootstrap-"),
  );
  process.env.__TALON_OPENCODE_TEST_HOME = TALON_ROOT;
  const r = (...parts: string[]) => path.resolve(TALON_ROOT, ...parts);
  return {
    dirs: {
      root: TALON_ROOT,
      data: r("data"),
      workspace: r("workspace"),
      uploads: r("workspace", "uploads"),
      logs: r("workspace", "logs"),
      memory: r("workspace", "memory"),
      dailyMemory: r("workspace", "memory", "daily"),
      stickers: r("workspace", "stickers"),
      prompts: r("prompts"),
      traces: r("data", "traces"),
      palace: r("workspace", "palace"),
      triggerRuns: r("data", "trigger-runs"),
    },
    files: {
      config: r("config.json"),
      log: r("talon.log"),
      sessions: r("data", "sessions.json"),
      history: r("data", "history.json"),
      chatSettings: r("data", "chat-settings.json"),
      cron: r("data", "cron.json"),
      triggers: r("data", "triggers.json"),
      mediaIndex: r("data", "media-index.json"),
      memory: r("workspace", "memory", "memory.md"),
      identity: r("workspace", "identity.md"),
      userSession: r(".user-session"),
      pid: r("talon.pid"),
      mempalacePython: r(
        "mempalace-venv",
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python",
      ),
      dreamState: r("workspace", "memory", "dream_state.json"),
      heartbeatState: r("workspace", "memory", "heartbeat_state.json"),
    },
  };
});

// ── Module-level state ─────────────────────────────────────────────────────

let gateway: Gateway | null = null;
let opencodeProc: ChildProcess | null = null;
let opencodeStateDir: string | null = null;
const recording = makeRecordingHandler();

function spawnIsolatedOpencode(port: number, stateDir: string): ChildProcess {
  const command = cliCommand("opencode", OPENCODE_EXECUTABLE_ENV);
  return spawn(
    command,
    ["serve", "--hostname=127.0.0.1", `--port=${port}`, "--log-level=ERROR"],
    {
      cwd: stateDir,
      env: {
        ...process.env,
        HOME: stateDir,
        XDG_DATA_HOME: resolve(stateDir, ".local/share"),
        XDG_CONFIG_HOME: resolve(stateDir, ".config"),
        XDG_CACHE_HOME: resolve(stateDir, ".cache"),
        XDG_STATE_HOME: resolve(stateDir, ".local/state"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

opencodeDescribe("OpenCode backend — real bootstrap (integration)", () => {
  beforeAll(async () => {
    if (!OPENCODE_PRESENT) {
      throw new Error(
        "opencode CLI required for this suite (set OPENCODE_EXECUTABLE or install opencode-ai).",
      );
    }

    // Sanity: env override took effect before opencode/server.js loaded.
    const { OPENCODE_BASE_URL } =
      await import("../../backend/opencode/server.js");
    if (OPENCODE_BASE_URL !== TEST_BASE_URL) {
      throw new Error(
        `OPENCODE_PORT env override didn't take effect. Expected base ${TEST_BASE_URL}, got ${OPENCODE_BASE_URL}. ` +
          `(Did opencode/server.js load before vi.hoisted ran?)`,
      );
    }

    opencodeStateDir = mkdtempSync(
      resolve(tmpdir(), "talon-opencode-isolated-"),
    );
    opencodeProc = spawnIsolatedOpencode(TEST_PORT, opencodeStateDir);
    let stderr = "";
    opencodeProc.stdout?.on("data", () => {
      /* drain */
    });
    opencodeProc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    opencodeProc.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
    });
    try {
      await waitForHealthy(TEST_BASE_URL, HEALTH_TIMEOUT_MS);
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nisolated opencode stderr:\n${stderr || "(empty)"}`,
      );
    }

    // Pick a free model from the live opencode catalog.
    const { getOpenCodeModelCatalog, clearModelCatalogCache } =
      await import("../../backend/opencode/models.js");
    clearModelCatalogCache();
    const catalog = await getOpenCodeModelCatalog(/* forceRefresh */ true);
    const free = catalog.connectedFreeModels[0];
    if (!free) {
      throw new Error(
        "No free OpenCode models discovered — cannot run real-bootstrap test.",
      );
    }
    const modelId = `${free.providerID}/${free.id}`;

    const TEST_HOME = process.env.__TALON_OPENCODE_TEST_HOME!;
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(resolve(TEST_HOME, "data"), { recursive: true });
    mkdirSync(resolve(TEST_HOME, "workspace", "memory"), { recursive: true });
    writeFileSync(
      resolve(TEST_HOME, "config.json"),
      JSON.stringify(
        {
          frontend: "telegram",
          backend: "opencode",
          model: modelId,
          botToken: "test-bot-token",
          systemPrompt: "You are a test assistant. Be terse.",
          pulse: false,
          heartbeat: false,
          plugins: [],
        },
        null,
        2,
      ) + "\n",
    );

    // Pre-seed dream state — same race that bit the kilo test.
    writeFileSync(
      resolve(TEST_HOME, "workspace", "memory", "dream_state.json"),
      JSON.stringify({
        last_run: Date.now(),
        last_run_iso: new Date().toISOString(),
        status: "idle",
      }) + "\n",
    );

    gateway = new Gateway();
    gateway.setFrontendHandler(recording.handler);
    await gateway.start(0);

    const ctx: ContextManager = {
      acquire: () => {},
      release: () => {},
      getMessageCount: () => 0,
    };
    const frontend: Frontend = {
      name: "telegram",
      context: ctx,
      sendTyping: async () => {},
      sendMessage: async () => {},
      getBridgePort: () => gateway!.getPort(),
      init: async () => {},
      start: async () => {},
      stop: async () => {},
    };

    const { bootstrap, initBackendAndDispatcher } =
      await import("../../bootstrap.js");
    await bootstrap();
    const { loadConfig } = await import("../../util/config.js");
    await initBackendAndDispatcher(loadConfig(), frontend);
  }, 180_000);

  afterAll(async () => {
    try {
      await gateway?.stop();
    } catch {
      /* swallow */
    }
    await stopProcess(opencodeProc);
    opencodeProc = null;
    if (opencodeStateDir) {
      try {
        rmSync(opencodeStateDir, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
      opencodeStateDir = null;
    }
    const TEST_HOME = process.env.__TALON_OPENCODE_TEST_HOME;
    if (TEST_HOME) {
      try {
        rmSync(TEST_HOME, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
      delete process.env.__TALON_OPENCODE_TEST_HOME;
    }
  });

  // ── Test 1: real wiring delivers a response ──────────────────────────────

  it("real bootstrap delivers a response from a live free-tier model", async () => {
    recording.reset();
    const textBlocks: string[] = [];
    const toolUses: { name: string; input: Record<string, unknown> }[] = [];
    const { execute } = await import("../../core/dispatcher.js");

    const result = await execute({
      chatId: "opencode-real-bootstrap-1",
      numericChatId: 992_001,
      prompt:
        "Answer with the single word 'hello'. " +
        "If you can call tools, prefer calling react with the 👋 emoji " +
        "followed by end_turn(text='hello').",
      senderName: "Test",
      isGroup: false,
      source: "message",
      onTextBlock: async (text) => {
        textBlocks.push(text);
      },
      onToolUse: (name, input) => {
        toolUses.push({ name, input });
      },
    });

    expect(result.durationMs).toBeGreaterThan(0);

    const reacts = recording.byAction("react");
    const sends = recording.byAction("send_message");
    const replies = recording.byAction("reply_to");
    const totalBridgeCalls = reacts.length + sends.length + replies.length;
    const totalText = textBlocks.join("").trim();

    expect(
      totalBridgeCalls + totalText.length,
      `model produced no delivery. ` +
        `bridgeCalls=${totalBridgeCalls} textLen=${totalText.length} ` +
        `actions=[${recording.captured.map((c) => c.body.action).join(", ")}] ` +
        `tools=[${toolUses.map((t) => t.name).join(", ")}]`,
    ).toBeGreaterThan(0);

    if (reacts.length > 0) {
      const r = reacts[0];
      expect(r.body.action).toBe("react");
      expect(typeof r.body.emoji).toBe("string");
      expect(r.chatId).toBe(992_001);
    }
    if (sends.length > 0) {
      const s = sends[0];
      expect(s.body.action).toBe("send_message");
      expect(s.chatId).toBe(992_001);
    }
  }, 240_000);

  // ── Test 2: cross-chat MCP isolation ─────────────────────────────────────
  //
  // Per-session permission rules block tool *execution* but not *visibility*
  // — OpenCode exposes every registered MCP server's tools to every session.
  // The fix (`ensureChatMcpServer` in `remote-server/mcp.ts`) holds at most
  // one chat `talon-tools-<chatId>` registered at a time, disconnecting any
  // other when a new chat starts. Same model as the Kilo backend; both
  // wrap forks of the same upstream HTTP API.
  //
  // This test exercises the disconnect path against a real `opencode`
  // server: run a turn for chat A, then a turn for chat B, then assert
  // that only chat B's MCP server remains registered (chat A's was
  // disconnected before chat B's was added). Talon's local
  // `registeredMcpServers` Set is the source of truth — OpenCode's
  // `GET /mcp` returns `{}` regardless of state, so we read the cache
  // directly via `getRegisteredMcpServerNames`.

  it("chat-switch disconnects the previous chat's MCP server", async () => {
    recording.reset();
    const { execute } = await import("../../core/dispatcher.js");
    const { getRegisteredMcpServerNames } =
      await import("../../backend/opencode/server.js");

    // Turn 1 — chat A. The model's reply doesn't matter; we just need
    // its MCP server to get registered.
    await execute({
      chatId: "opencode-isolation-a",
      numericChatId: 992_010,
      prompt: "Reply with the single word 'a'.",
      senderName: "Test",
      isGroup: false,
      source: "message",
    });

    const afterA = getRegisteredMcpServerNames().filter((n) =>
      n.startsWith("talon-tools-"),
    );
    expect(
      afterA,
      `expected chat A's MCP to be registered after turn 1; got [${afterA.join(", ")}]`,
    ).toContain("talon-tools-opencode-isolation-a");

    // Turn 2 — chat B. Chat A's MCP must be disconnected before chat B's
    // is added; production logs `Disconnected talon-tools-... (chat switch)`
    // when this fires.
    await execute({
      chatId: "opencode-isolation-b",
      numericChatId: 992_011,
      prompt: "Reply with the single word 'b'.",
      senderName: "Test",
      isGroup: false,
      source: "message",
    });

    const afterB = getRegisteredMcpServerNames();
    const chatServers = afterB.filter((n) => n.startsWith("talon-tools-"));

    expect(chatServers).toContain("talon-tools-opencode-isolation-b");
    expect(
      chatServers,
      `chat A's MCP must be disconnected after switch; cache=[${chatServers.join(", ")}]`,
    ).not.toContain("talon-tools-opencode-isolation-a");

    // Heartbeat sentinel (if present) is exempt from the chat-switch
    // disconnect, but should be the ONLY non-chat talon-tools-* in the
    // cache. Anything else means a stale chat MCP wasn't disconnected.
    const nonHeartbeat = chatServers.filter(
      (n) => n !== "talon-tools-heartbeat",
    );
    expect(nonHeartbeat).toEqual(["talon-tools-opencode-isolation-b"]);
  }, 300_000);
});
