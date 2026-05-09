/**
 * Functional-test bootstrap for Talon's claude-sdk backend against the stub
 * binary.
 *
 * Boots `initAgent()` with a minimal config that wires `claudeBinary` to the
 * stub script and uses `registerClaudeModelsStatic` to skip the SDK's model
 * discovery round-trip (otherwise every test would have to handle the
 * `supportedModels()` control flow). The result is a real `handleMessage()`
 * call path: prompt enrichment, system-prompt rebuild, options builder,
 * SDK query, stream processing, dedup, session bookkeeping — all the same
 * code the production bot runs, just talking to a deterministic stub instead
 * of the live API.
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
import { registerClaudeModelsStatic } from "../../backend/claude-sdk/models.js";
import { resetSession } from "../../storage/sessions.js";

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

/**
 * Idempotent boot — first call initializes the agent, subsequent calls reuse
 * the same in-process state. Safe to call from every test's beforeAll.
 */
export async function ensureBooted(): Promise<void> {
  if (booted) return;

  const workspace = mkdtempSync(resolve(tmpdir(), "talon-stub-workspace-"));
  bootedTmpDirs.push(workspace);

  const config: TalonConfig = {
    frontend: "terminal",
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

  // Skip SDK model discovery — registers a synthetic model list so handler.ts
  // can resolve "claude-sonnet-4-6" without spawning the binary just to ask.
  registerClaudeModelsStatic([
    {
      id: "claude-sonnet-4-6",
      displayName: "Sonnet (stub)",
      description: "Stub model for integration tests",
      aliases: [],
      provider: "anthropic",
    },
  ]);

  await initAgent(config);
  booted = true;
}

/** Tear-down hook for tests that want a clean slate. */
export function teardownBootstrap(): void {
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
  await ensureBooted();

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
  process.env.STUB_CLAUDE_TIMEOUT_MS = "10000";

  const textChunks: string[] = [];
  const toolUses: { name: string; input: Record<string, unknown> }[] = [];
  const streamDeltas: { phase?: string; text: string }[] = [];

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
    delete process.env.STUB_CLAUDE_SCRIPT;
    delete process.env.STUB_CLAUDE_LOG;
    delete process.env.STUB_CLAUDE_TIMEOUT_MS;
  }
}

/** Cleanup helper for tests that want to remove their tmp dirs. */
export function cleanupTurn(result: RunTalonTurnResult): void {
  rmSync(result.tmpDir, { recursive: true, force: true });
}
