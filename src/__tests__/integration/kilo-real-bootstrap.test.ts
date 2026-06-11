/**
 * Real-bootstrap integration test for the Kilo backend.
 *
 * No test-specific bootstrap helper — this file calls Talon's production
 * `bootstrap()` and `initBackendAndDispatcher()` exactly as `index.ts` does.
 * The only test-side fakes are:
 *
 *   1. `vi.mock("../../util/paths.js")` — redirects `dirs.root` (and every
 *      derived file path) to an isolated tempdir so the test never touches
 *      the developer's real `~/.talon/` config or sessions.
 *
 *   2. `vi.hoisted(() => process.env.KILO_PORT = ...)` — points the
 *      production `KILO_PORT` const at a port distinct from prod's 4097, so
 *      the real `ensureServer()` spawns its own `kilo serve` rather than
 *      reusing whatever's listening on the default port.
 *
 *   3. A minimal `Frontend` object — supplies `getBridgePort` (live Gateway),
 *      no-op `sendTyping` / `sendMessage`, and a tiny `ContextManager`. The
 *      production Telegram/Discord/Teams frontends provide identically-shaped
 *      objects; this is the same boundary, just wired to a `RecordingHandler`
 *      instead of an external chat platform.
 *
 * What runs unmocked:
 *   - `bootstrap()` — config load, env vars, plugin load, workspace init,
 *     storage load, daily-log cleanup.
 *   - `initBackendAndDispatcher()` — backend factory registration + lookup,
 *     `factory.init(config, ctx)`, dispatcher init, pulse, cron, triggers,
 *     dream, heartbeat.
 *   - `ensureServer()` — real Kilo SDK `createKiloServer` spawn. The test
 *     port is supplied via the env-var override, not a mocked client.
 *   - `dispatcher.execute()` — the real per-chat serial chain, real
 *     `handleMessage` against the real spawned `kilo serve`.
 *
 * Skipping:
 *   The suite is gated behind the `kilo` CLI being on PATH (or
 *   KILO_CODE_EXECUTABLE pointing at it). CI sets KILO_LIVE_REQUIRED=1 so
 *   missing CLI fails there instead of being silently skipped.
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
import { Gateway } from "../../core/engine/gateway.js";
import { makeRecordingHandler } from "./recording-handler.js";
import type { Frontend } from "../../bootstrap.js";
import type { ContextManager } from "../../core/types.js";

// ── Preflight gating ───────────────────────────────────────────────────────

const KILO_EXECUTABLE_ENV = "KILO_CODE_EXECUTABLE";
const KILO_PRESENT = cliAvailable("kilo", KILO_EXECUTABLE_ENV);
const KILO_REQUIRED = process.env.KILO_LIVE_REQUIRED === "1";
const kiloDescribe = KILO_PRESENT || KILO_REQUIRED ? describe : describe.skip;

// ── Hoisted env: KILO_PORT must be set BEFORE kilo/server.js loads ────────
//
// `KILO_PORT` is read at module-init time (top-level const). vi.hoisted()
// runs before all imports, so by the time any code reads `KILO_PORT`,
// the override is already in place. 4199 sits clear of:
//   4096 — prod opencode    4097 — prod kilo
//   4197 — opencode-live    4198 — kilo-live
const TEST_PORT = vi.hoisted(() => {
  const port = String(process.env.KILO_REAL_BOOTSTRAP_PORT ?? "4199");
  process.env.KILO_PORT = port;
  return Number(port);
});

const TEST_BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// ── vi.mock: paths.js → isolated tempdir ───────────────────────────────────
//
// Factory runs at first import of paths.js (before bootstrap loads). It
// creates a fresh tempdir and exposes the path back to the test body via
// `process.env.__TALON_TEST_HOME` so `beforeAll` can drop a `config.json`
// into it before `bootstrap()` runs.

vi.mock("../../util/paths.js", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const TALON_ROOT = fs.mkdtempSync(
    path.resolve(os.tmpdir(), "talon-real-bootstrap-"),
  );
  process.env.__TALON_TEST_HOME = TALON_ROOT;
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
let kiloProc: ChildProcess | null = null;
let kiloStateDir: string | null = null;
const recording = makeRecordingHandler();

const HEALTH_TIMEOUT_MS = 15_000;

/**
 * Spawn `kilo serve` with **fully isolated state** so it cannot share data
 * with the developer's running production Talon. Three things matter:
 *
 *   - `cwd` set to a fresh tempdir → kilo derives its `projectID` from a
 *     hash of the working directory; a unique cwd → unique projectID →
 *     no shared sessions / MCP catalog with prod's `/home/dylan/...` cwd.
 *   - `HOME` + `XDG_DATA_HOME` + `XDG_CONFIG_HOME` set inside the tempdir
 *     → kilo writes its global state under our temp tree, not
 *     `~/.local/share/kilocode/`.
 *   - `--pure` → run without external plugins (no auto-loaded extras).
 *
 * Without these, the test kilo on TEST_PORT reads prod kilo's persisted
 * MCP catalog (`talon-tools-dream`, every `talon-tools-<chatId>` from prod
 * sessions) and the model in our test sees + happily calls those tools,
 * routing bridge calls to the wrong context.
 */
function spawnIsolatedKilo(port: number, stateDir: string): ChildProcess {
  const command = cliCommand("kilo", KILO_EXECUTABLE_ENV);
  return spawn(
    command,
    [
      "serve",
      "--hostname=127.0.0.1",
      `--port=${port}`,
      "--log-level=ERROR",
      "--pure",
    ],
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

kiloDescribe("Kilo backend — real bootstrap (integration)", () => {
  beforeAll(async () => {
    if (!KILO_PRESENT) {
      throw new Error(
        "kilo CLI required for this suite (set KILO_CODE_EXECUTABLE or install @kilocode/cli).",
      );
    }

    // Sanity: the env override took effect before kilo/server.js loaded.
    const { KILO_BASE_URL } = await import("../../backend/kilo/server.js");
    if (KILO_BASE_URL !== TEST_BASE_URL) {
      throw new Error(
        `KILO_PORT env override didn't take effect. Expected base ${TEST_BASE_URL}, got ${KILO_BASE_URL}. ` +
          `(Did kilo/server.js load before vi.hoisted ran?)`,
      );
    }

    // Pre-spawn an ISOLATED kilo serve. Real `ensureServer()` will see it
    // healthy at TEST_PORT and call `reuseExistingServer()` rather than
    // spawning one itself (which would inherit our env+cwd and share state
    // with prod). See `spawnIsolatedKilo` for the isolation rationale.
    kiloStateDir = mkdtempSync(resolve(tmpdir(), "talon-kilo-isolated-"));
    kiloProc = spawnIsolatedKilo(TEST_PORT, kiloStateDir);
    let stderr = "";
    kiloProc.stdout?.on("data", () => {
      /* drain */
    });
    kiloProc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    kiloProc.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
    });
    try {
      await waitForHealthy(TEST_BASE_URL, HEALTH_TIMEOUT_MS);
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nisolated kilo stderr:\n${stderr || "(empty)"}`,
      );
    }

    // 1. Pick a free model from the live catalog.
    //    Real deployment behaviour: discover what Kilo offers, don't pin a
    //    name that might disappear from the catalog tomorrow.
    //
    //    `getOpenCodeModelCatalog()` calls `ensureServer()` internally, which
    //    spawns the test-port `kilo serve` on the very first invocation. So
    //    this also doubles as the server warm-up.
    const { getOpenCodeModelCatalog, clearModelCatalogCache } =
      await import("../../backend/kilo/models.js");
    clearModelCatalogCache();
    const catalog = await getOpenCodeModelCatalog(/* forceRefresh */ true);
    const free = catalog.connectedFreeModels[0];
    if (!free) {
      throw new Error(
        "No free Kilo models discovered — cannot run real-bootstrap test.",
      );
    }
    const modelId = `${free.providerID}/${free.id}`;

    // 2. Seed the isolated $HOME with a real config.json.
    const TEST_HOME = process.env.__TALON_TEST_HOME!;
    mkdirSync(TEST_HOME, { recursive: true });
    mkdirSync(resolve(TEST_HOME, "data"), { recursive: true });
    mkdirSync(resolve(TEST_HOME, "workspace", "memory"), { recursive: true });
    writeFileSync(
      resolve(TEST_HOME, "config.json"),
      JSON.stringify(
        {
          frontend: "telegram",
          backend: "kilo",
          model: modelId,
          // Telegram frontend validation requires botToken — never used,
          // since we never call frontend.start().
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

    // Pre-seed dream state so `maybeStartDream()` (called from
    // dispatcher.execute()) finds the 12h interval not-yet-elapsed and
    // returns immediately. Otherwise dream fires on first dispatch and its
    // `talon-tools-dream` MCP server races against our chat's MCP setup —
    // when dream wins, the model sees `talon-tools-dream_*` tools in its
    // catalog and cheerfully calls `talon-tools-dream_end_turn` instead of
    // the chat's, sending the bridge call to the wrong context.
    writeFileSync(
      resolve(TEST_HOME, "workspace", "memory", "dream_state.json"),
      JSON.stringify({
        last_run: Date.now(),
        last_run_iso: new Date().toISOString(),
        status: "idle",
      }) + "\n",
    );

    // 3. Boot a Gateway with a recording action handler.
    //    Talon-MCP tool calls (react / send / end_turn / read_history / …)
    //    POST here; the recording handler captures every body for assertion.
    gateway = new Gateway();
    gateway.setFrontendHandler(recording.handler);
    await gateway.start(0);

    // 4. Build the minimal Frontend object the production bootstrap expects.
    //    Same shape as TelegramFrontend / DiscordFrontend / TeamsFrontend —
    //    just wired to in-memory hooks instead of an external chat platform.
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

    // 5. Run the REAL production bootstrap. Same code path as `index.ts`.
    const { bootstrap, initBackendAndDispatcher } =
      await import("../../bootstrap.js");
    await bootstrap();
    const { loadConfig } = await import("../../util/config.js");
    await initBackendAndDispatcher(loadConfig(), frontend);
  }, 120_000);

  afterAll(async () => {
    try {
      await gateway?.stop();
    } catch {
      /* swallow */
    }
    await stopProcess(kiloProc);
    kiloProc = null;
    if (kiloStateDir) {
      try {
        rmSync(kiloStateDir, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
      kiloStateDir = null;
    }
    const TEST_HOME = process.env.__TALON_TEST_HOME;
    if (TEST_HOME) {
      try {
        rmSync(TEST_HOME, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
      delete process.env.__TALON_TEST_HOME;
    }
  });

  // ── Test 1: real wiring delivers the model's response ────────────────────
  //
  // Proves that the production bootstrap → dispatcher → kilo serve → SDK →
  // session → SSE → handler → onTextBlock / bridge chain is intact end to
  // end. We don't assert the model's choice of delivery channel (text vs
  // tool) — free-tier models vary turn-to-turn and that's outside the
  // wiring under test. The PR-bound regression is "Talon receives ANY
  // response from the live model"; the chosen channel is incidental.
  //
  // We DO conditionally assert on shape if the model picked tools — those
  // assertions catch real wiring bugs (chatId mismatches, missing emoji
  // arg propagation, etc.) and are skipped when the model went text-only.

  it("real bootstrap delivers a response from a live free-tier model", async () => {
    recording.reset();
    const textBlocks: string[] = [];
    const toolUses: { name: string; input: Record<string, unknown> }[] = [];
    const { execute } = await import("../../core/engine/dispatcher.js");

    const result = await execute({
      chatId: "real-bootstrap-test-1",
      numericChatId: 991_001,
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

    // The wiring is healthy iff Talon received SOMETHING — either a
    // text-part delivery or a bridged tool call. Both flow through the
    // same real pipeline; either reaching us proves the chain is intact.
    expect(
      totalBridgeCalls + totalText.length,
      `model produced no delivery. ` +
        `bridgeCalls=${totalBridgeCalls} textLen=${totalText.length} ` +
        `actions=[${recording.captured.map((c) => c.body.action).join(", ")}] ` +
        `tools=[${toolUses.map((t) => t.name).join(", ")}]`,
    ).toBeGreaterThan(0);

    // If the model picked the tool route, verify the bridged shape — this
    // catches chatId-mapping bugs and bridge body-shape regressions.
    if (reacts.length > 0) {
      const r = reacts[0];
      expect(r.body.action).toBe("react");
      expect(typeof r.body.emoji).toBe("string");
      expect(r.chatId).toBe(991_001);
    }
    if (sends.length > 0) {
      const s = sends[0];
      expect(s.body.action).toBe("send_message");
      expect(s.chatId).toBe(991_001);
    }
  }, 180_000);

  // ── Test 2: cross-chat MCP isolation ─────────────────────────────────────
  //
  // Per-session permission rules block tool *execution* but not *visibility*
  // — Kilo exposes every registered MCP server's tools to every session.
  // The fix (`ensureChatMcpServer` in server.ts) holds at most one chat
  // `talon-tools-<chatId>` registered at a time, disconnecting any other
  // when a new chat starts.
  //
  // This test exercises the disconnect path against a real `kilo serve`:
  // run a turn for chat A, then a turn for chat B, then assert that only
  // chat B's MCP server remains registered (chat A's was disconnected
  // before chat B's was added). Talon's local `registeredMcpServers` Set
  // is the source of truth — Kilo's `GET /mcp` returns `{}` regardless of
  // state, so we read the cache directly via `getRegisteredMcpServerNames`.

  it("chat-switch disconnects the previous chat's MCP server", async () => {
    recording.reset();
    const { execute } = await import("../../core/engine/dispatcher.js");
    const { getRegisteredMcpServerNames } =
      await import("../../backend/kilo/server.js");

    // Turn 1 — chat A. The model's reply doesn't matter; we just need
    // its MCP server to get registered.
    await execute({
      chatId: "isolation-chat-a",
      numericChatId: 991_010,
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
    ).toContain("talon-tools-isolation-chat-a");

    // Turn 2 — chat B. Chat A's MCP must be disconnected before chat B's
    // is added; production logs `Disconnected talon-tools-... (chat switch)`
    // when this fires.
    await execute({
      chatId: "isolation-chat-b",
      numericChatId: 991_011,
      prompt: "Reply with the single word 'b'.",
      senderName: "Test",
      isGroup: false,
      source: "message",
    });

    const afterB = getRegisteredMcpServerNames();
    const chatServers = afterB.filter((n) => n.startsWith("talon-tools-"));

    expect(chatServers).toContain("talon-tools-isolation-chat-b");
    expect(
      chatServers,
      `chat A's MCP must be disconnected after switch; cache=[${chatServers.join(", ")}]`,
    ).not.toContain("talon-tools-isolation-chat-a");

    // Heartbeat sentinel (if present) is exempt from the chat-switch
    // disconnect, but should be the ONLY non-chat talon-tools-* in the
    // cache. Anything else means a stale chat MCP wasn't disconnected.
    const nonHeartbeat = chatServers.filter(
      (n) => n !== "talon-tools-heartbeat",
    );
    expect(nonHeartbeat).toEqual(["talon-tools-isolation-chat-b"]);
  }, 240_000);

  // Synthetic output-cap path coverage lives at the unit level:
  //   - kilo-events.test.ts asserts `extractPartsSummary` peels
  //     `synthetic: true` parts into `syntheticErrorText`.
  //   - kilo-server.test.ts asserts the handler routes synthetic into
  //     the `delivery: synthetic-error` branch.
  // We can't reliably trigger Kilo's synthetic-part injection from a
  // real upstream model — it's gated on provider-side anomalies we
  // don't control. No live test for it here on purpose.
});
