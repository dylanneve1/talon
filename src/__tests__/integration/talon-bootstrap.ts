/**
 * Functional-test bootstrap for Talon's claude-sdk backend against the stub
 * binary.
 *
 * Calls the **production** `initAgent()` entry point with `claudeBinary`
 * pointed at the stub. No workarounds — the stub advertises its mock models
 * via the standard `SDKControlInitializeResponse.models` field, so
 * `registerClaudeModels()` discovers them by spawning the stub and walking
 * the real init handshake. The result is the entire production code path
 * exercised end-to-end: model discovery, prompt enrichment, system-prompt
 * rebuild, options builder, SDK query, stream processing, dedup, session
 * bookkeeping — only the binary the SDK spawns is fake.
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
import { initAgent } from "../../backend/claude-sdk/state.js";
import { handleMessage } from "../../backend/claude-sdk/handler.js";
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
const bootedTmpDirs: string[] = [];
let gateway: Gateway | null = null;

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
    heartbeat: false,
    heartbeatIntervalMinutes: 60,
    plugins: [],
    botDisplayName: "Talon (stub)",
    teamsWebhookPort: 19878,
    teamsGraphPollMs: 10_000,
    systemPrompt: "Test system prompt.",
    workspace,
  };

  // Spin up a Gateway when the frontend isn't terminal. The SDK's `mcpServers`
  // config (built via `buildMcpServers`) includes a `${frontend}-tools` server
  // for non-terminal frontends — when that MCP server invokes a tool, it
  // POSTs to `http://127.0.0.1:${gateway.port}/...` to reach the frontend
  // handler. Without a live gateway those POSTs would hang or 404.
  let getBridgePort: (() => number) | undefined;
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
    getBridgePort = () => gateway!.getPort();
  }

  // Run the production bootstrap — `initAgent` calls `registerClaudeModels`
  // which spawns the stub binary, performs the init handshake, and pulls the
  // model list out of the SDKControlInitializeResponse. The stub advertises
  // its mock models in `defaultInitResponse.models` (`fake-claude.mjs`), so
  // discovery resolves naturally without any test-side override.
  await initAgent(config, getBridgePort);
  booted = true;
}

/** Tear-down hook for tests that want a clean slate. */
export function teardownBootstrap(): void {
  if (gateway) {
    void gateway.stop();
    gateway = null;
  }
  for (const dir of bootedTmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
  /** Token + duration stats from `handleMessage`. */
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Lines from the stub's protocol log. */
  protocolLog: string[];
  /** Tmp dir used (cleaned up automatically). */
  tmpDir: string;
}

/**
 * Drives a full Talon turn against the stub binary. Real `handleMessage`
 * runs end-to-end — prompt building, SDK query, stream processing, session
 * persistence — but the SDK talks to the stub instead of the API.
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
    const result = await handleMessage({
      chatId,
      text: prompt,
      senderName,
      isGroup,
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
