/**
 * Functional-test bootstrap for Talon's claude-sdk backend against the stub
 * binary.
 *
 * Boots through the **production composition root**
 * (`initBackendAndDispatcher`) with `claudeBinary` pointed at the stub, and
 * drives each turn through the production `dispatcher.execute()`. The only
 * fake is the `Frontend` object — the same seam `index.ts` swaps per
 * platform. Everything else is the real path: backend factory registration,
 * backend pool boot, model discovery (the stub advertises mock models via
 * the standard `SDKControlInitializeResponse.models` field), dispatcher
 * wiring, active-model resolution, SDK query, stream processing, the
 * event→callback bridge, dedup, and session bookkeeping — only the binary
 * the SDK spawns is fake.
 *
 * Usage in tests:
 *
 *   import { runTalonTurn } from "./talon-bootstrap.js";
 *   import { assistantText, successResult } from "./stub-claude/helpers.js";
 *
 *   const result = await runTalonTurn({
 *     prompt: "hello",
 *     script: { turns: [{ emit: [assistantText("hi"), successResult()] }] },
 *   });
 *
 *   expect(result.text).toBe("hi");
 *   expect(result.toolUses).toHaveLength(0);
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import type { TalonConfig } from "../../util/config.js";
import { initBackendAndDispatcher, type Frontend } from "../../bootstrap.js";
import { execute as dispatcherExecute } from "../../core/dispatcher.js";
import { resetSession } from "../../storage/sessions.js";
import { Gateway } from "../../core/gateway.js";
import type { FrontendActionHandler } from "../../core/types.js";

import type { StubScript } from "./stub-claude/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// See stub-claude/helpers.ts for the Windows-vs-POSIX rationale.
const STUB_BINARY = resolve(
  __dirname,
  process.platform === "win32"
    ? "stub-claude/fake-claude.exe"
    : "stub-claude/fake-claude.mjs",
);

let booted = false;
/**
 * Whether the heavy composition root (`initBackendAndDispatcher`) has run.
 * Backend pool + dispatcher are process-level singletons wired against the
 * config captured at first boot — they boot once and persist for the test
 * process. `teardownBootstrap()` only swaps the gateway wiring; the SDK
 * keeps spawning into the same workspace.
 */
let coreBooted = false;
const bootedTmpDirs: string[] = [];
let gateway: Gateway | null = null;

/**
 * Stable bridge-port accessor handed to the composition root once. Reads
 * the CURRENT module-level gateway, so a teardown/re-boot cycle that swaps
 * in a new gateway (fresh port, fresh recording handler) is picked up by
 * the already-booted backend on its next `buildMcpServers` call.
 */
function currentBridgePort(): number {
  return gateway?.getPort() ?? 0;
}

// Workspaces are tiny tmp dirs; clean them when the test process exits.
// They must NOT be removed in `teardownBootstrap()` — the booted backend
// keeps using the first boot's workspace as the SDK spawn cwd, and
// deleting it makes every subsequent stub launch fail.
process.on("exit", () => {
  for (const dir of bootedTmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/**
 * Boot configuration. Default boots a `frontend: "terminal"` agent with no
 * gateway — sufficient for backend-only tests that observe `onToolUse`
 * without dispatching anywhere. Pass `frontend: "telegram"` (or `"teams"`)
 * to spin up a real `Gateway` HTTP bridge so the SDK can route MCP-driven
 * tool calls through `Talon`'s production MCP server back to a frontend
 * action handler the test provides.
 */
export interface EnsureBootedArgs {
  /** Frontend wired into the SDK's MCP config. Default `"terminal"`. */
  frontend?: TalonConfig["frontend"];
  /**
   * Action handler invoked when the SDK dispatches a Telegram/Teams tool
   * via MCP and the resulting `tool.execute(params, bridge)` call arrives at
   * the gateway. Required when `frontend !== "terminal"` — the gateway will
   * 404 every action otherwise.
   *
   * Tests typically pass a recording handler (capture every action body for
   * later assertion) or a thin shim around a live API client.
   */
  gatewayHandler?: FrontendActionHandler;
}

/**
 * Idempotent boot — first call initializes the agent, subsequent calls reuse
 * the same in-process state. Safe to call from every test's beforeAll.
 *
 * Subsequent calls with different `frontend` / `gatewayHandler` settings are
 * silently ignored — call `teardownBootstrap()` first if a test needs to
 * change the wiring.
 */
export async function ensureBooted(args: EnsureBootedArgs = {}): Promise<void> {
  if (booted) return;

  const { frontend = "terminal", gatewayHandler } = args;

  // Spin up a Gateway when the frontend isn't terminal. The SDK's
  // `mcpServers` config (built via `buildMcpServers`) includes a
  // `${frontend}-tools` server for non-terminal frontends — when that MCP
  // server invokes a tool, it POSTs to `http://127.0.0.1:${gateway.port}/…`
  // to reach the frontend handler. Without a live gateway those POSTs
  // would hang or 404. Re-created on every boot so each describe block
  // can wire its own recording handler.
  if (frontend !== "terminal") {
    if (!gatewayHandler) {
      throw new Error(
        `ensureBooted: frontend=${JSON.stringify(frontend)} requires a gatewayHandler. ` +
          `Pass a recording handler or a live-API shim.`,
      );
    }
    gateway = new Gateway();
    gateway.setFrontendHandler(gatewayHandler);
    // Port 0 → OS picks a free port; tests don't care which.
    await gateway.start(0);
  }

  if (coreBooted) {
    // Composition root already wired — the new gateway (if any) is picked
    // up through `currentBridgePort` on the next turn.
    booted = true;
    return;
  }

  const workspace = mkdtempSync(resolve(tmpdir(), "talon-stub-workspace-"));
  bootedTmpDirs.push(workspace);

  const config: TalonConfig = {
    frontend,
    backend: "claude",
    claudeBinary: STUB_BINARY,
    model: "claude-sonnet-4-6",
    maxMessageLength: 4000,
    concurrency: 1,
    pulse: false,
    pulseIntervalMs: 300_000,
    // Dreams read ~/.talon dream state and fire-and-forget a one-shot
    // agent mid-turn — nondeterministic in tests. Explicitly disabled.
    dream: false,
    heartbeat: false,
    heartbeatIntervalMinutes: 60,
    plugins: [],
    botDisplayName: "Talon (stub)",
    teamsWebhookPort: 19878,
    teamsGraphPollMs: 10_000,
    systemPrompt: "Test system prompt.",
    workspace,
  };

  // Run the REAL composition root — `initBackendAndDispatcher` registers
  // every backend factory, boots the backend pool (whose claude factory
  // calls `initAgent` → `registerClaudeModels`, spawning the stub binary
  // for the init handshake and model discovery), and wires the dispatcher
  // with the production `getBackend` / `resolveActiveModel` deps. The only
  // fake is the `Frontend` seam — the same seam `index.ts` swaps per
  // platform — so a wiring regression anywhere in the production boot
  // path fails these tests instead of being papered over by a parallel
  // test-only bootstrap.
  const feName = Array.isArray(frontend) ? frontend[0] : frontend;
  const fakeFrontend: Frontend = {
    name: feName,
    context: {
      acquire: () => {},
      release: () => {},
      getMessageCount: () => 0,
    },
    sendTyping: async () => {},
    sendMessage: async () => {},
    getBridgePort: currentBridgePort,
    init: async () => {},
    start: async () => {},
    stop: async () => {},
  };
  await initBackendAndDispatcher(config, fakeFrontend);
  coreBooted = true;
  booted = true;
}

/**
 * Tear-down hook for tests that want fresh gateway wiring (e.g. a new
 * recording handler per describe block). Stops the gateway only — the
 * backend pool, dispatcher, and workspace persist for the process (see
 * `coreBooted`), and the next `ensureBooted` call's gateway is picked up
 * through `currentBridgePort`.
 */
export function teardownBootstrap(): void {
  if (gateway) {
    void gateway.stop();
    gateway = null;
  }
  booted = false;
}

// ── Per-turn runner ────────────────────────────────────────────────────────

export interface RunTalonTurnArgs {
  prompt: string;
  script: StubScript;
  chatId?: string;
  senderName?: string;
  isGroup?: boolean;
  /** Reset the session bookkeeping for this chat before running. */
  resetSession?: boolean;
  /**
   * Forwarded to `ensureBooted()` on the first call. Subsequent calls reuse
   * the boot state — change the wiring by calling `teardownBootstrap()`
   * and then a fresh turn.
   */
  bootstrap?: EnsureBootedArgs;
}

/** Synthetic numeric ID derived from a string chat id — stable per-string. */
function syntheticNumericId(stringChatId: string): number {
  // Simple deterministic hash → positive int. No security or collision
  // requirements; just needs to be consistent within a test process.
  let h = 0;
  for (let i = 0; i < stringChatId.length; i++) {
    h = (h * 31 + stringChatId.charCodeAt(i)) >>> 0;
  }
  return h || 1;
}

export interface RunTalonTurnResult {
  /** Full assistant text accumulated across `onTextBlock` calls. */
  text: string;
  /** Tool calls observed via `onToolUse`. */
  toolUses: { name: string; input: Record<string, unknown> }[];
  /** Streaming deltas, in order. */
  streamDeltas: { phase?: string; text: string }[];
  /** Token + duration stats from the dispatcher's `ExecuteResult`. */
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Lines from the stub's protocol log. */
  protocolLog: string[];
  /** Tmp dir used (cleaned up automatically). */
  tmpDir: string;
}

/**
 * Drives a full Talon turn against the stub binary through the production
 * `dispatcher.execute()` — prompt building, SDK query, stream processing,
 * session persistence — but the SDK talks to the stub instead of the API.
 */
export async function runTalonTurn(
  args: RunTalonTurnArgs,
): Promise<RunTalonTurnResult> {
  await ensureBooted(args.bootstrap);

  const {
    prompt,
    script,
    chatId = "stub-chat-" + Math.random().toString(36).slice(2, 10),
    senderName = "TestUser",
    isGroup = false,
    resetSession: shouldResetSession = false,
  } = args;

  if (shouldResetSession) resetSession(chatId);

  const tmpDir = mkdtempSync(resolve(tmpdir(), "talon-turn-"));
  const scriptPath = resolve(tmpDir, "script.json");
  const logPath = resolve(tmpDir, "protocol.log");
  writeFileSync(scriptPath, JSON.stringify(script));

  process.env.STUB_CLAUDE_SCRIPT = scriptPath;
  process.env.STUB_CLAUDE_LOG = logPath;
  // MCP dispatch may take longer than the default — give it room.
  process.env.STUB_CLAUDE_TIMEOUT_MS = script.dispatchMcp ? "30000" : "10000";

  const textChunks: string[] = [];
  const toolUses: { name: string; input: Record<string, unknown> }[] = [];
  const streamDeltas: { phase?: string; text: string }[] = [];

  // When a gateway is wired (frontend !== "terminal"), register the chat
  // context BEFORE running the turn. Bridge calls from the MCP server include
  // `_chatId` and the gateway looks it up here.
  const numericChatId = gateway ? syntheticNumericId(chatId) : 0;
  if (gateway) gateway.setContext(numericChatId, chatId);

  try {
    // Drive the turn through the PRODUCTION dispatcher — per-chat
    // serialization, send-time model guard, active-model resolution,
    // and the event-stream → callback bridge all run for real.
    const result = await dispatcherExecute({
      chatId,
      numericChatId,
      prompt,
      senderName,
      isGroup,
      source: "message",
      onTextBlock: async (text) => {
        textChunks.push(text);
      },
      onToolUse: (name, input) => {
        toolUses.push({ name, input });
      },
      onStreamDelta: (accumulated, phase) => {
        streamDeltas.push({ phase, text: accumulated });
      },
    });

    let protocolLog: string[] = [];
    try {
      const { readFileSync } = await import("node:fs");
      protocolLog = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
    } catch {
      /* no log if stub never started */
    }

    return {
      text: textChunks.join(""),
      toolUses,
      streamDeltas,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      protocolLog,
      tmpDir,
    };
  } finally {
    if (gateway) gateway.clearContext(numericChatId);
    delete process.env.STUB_CLAUDE_SCRIPT;
    delete process.env.STUB_CLAUDE_LOG;
    delete process.env.STUB_CLAUDE_TIMEOUT_MS;
  }
}

/** Cleanup helper for tests that want to remove their tmp dirs. */
export function cleanupTurn(result: RunTalonTurnResult): void {
  rmSync(result.tmpDir, { recursive: true, force: true });
}
