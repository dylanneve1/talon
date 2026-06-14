/**
 * Functional-test bootstrap for Talon's **codex** backend against the stub
 * `codex` binary (`stub-codex/fake-codex.mjs`).
 *
 * Same philosophy as `talon-bootstrap.ts` (the claude harness): boot the REAL
 * composition root (`initBackendAndDispatcher`) and drive each turn through the
 * production `dispatcher.execute()`. The only fakes are the `Frontend` seam and
 * the `codex` executable (pointed at the stub via the `codexBinary` config /
 * `TALON_CODEX_BINARY` env added for this purpose).
 *
 * Everything else is the real path: codex factory registration, auth
 * detection (forced to api-key mode with a stub key), `ensureCodex` building a
 * real `Codex` SDK instance, `buildCodexMcpServers` flattening the MCP config
 * into `--config` argv, the codex-sdk spawning the stub per turn, the handler
 * parsing `ThreadEvent`s, and (when `dispatchMcp`) the stub routing tool calls
 * back through Talon's gateway.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

import type { TalonConfig } from "../../util/config.js";
import { initBackendAndDispatcher, type Frontend } from "../../bootstrap.js";
import { execute as dispatcherExecute } from "../../core/engine/dispatcher.js";
import { resetSession } from "../../storage/sessions.js";
import { initWorkspace } from "../../util/workspace.js";
import { Gateway } from "../../core/engine/gateway.js";
import type { FrontendActionHandler } from "../../core/types.js";

import type { CodexStubScript } from "./stub-codex/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_BINARY = resolve(__dirname, "stub-codex/fake-codex.mjs");

// The stub is a plain .mjs — make it runnable as an executable the codex-sdk
// can `spawn` directly. On POSIX the shebang + exec bit handle it; we set the
// bit at module load to be safe.
try {
  chmodSync(STUB_BINARY, 0o755);
} catch {
  /* best effort */
}

// MCP supervisor embedder hook (same rationale as talon-bootstrap.ts): the MCP
// servers Talon configures are launched via a Talon entry that dispatches
// `_mcp-launch`; under vitest, point it at cli.ts through tsx.
process.env.TALON_MCP_SUPERVISOR_CMD = JSON.stringify([
  process.execPath,
  "--import",
  pathToFileURL(
    resolve(__dirname, "../../../node_modules/tsx/dist/esm/index.mjs"),
  ).href,
  resolve(__dirname, "../../cli.ts"),
]);

// Force codex into api-key auth mode with a throwaway key so the backend
// registers + spawns the binary (the stub ignores the key). Point the base URL
// at a closed port so model discovery fails fast and falls back to the curated
// catalog instead of hitting real OpenAI.
process.env.TALON_CODEX_KEY = "stub-codex-key";
process.env.TALON_CODEX_BINARY = STUB_BINARY;

let booted = false;
let coreBooted = false;
const bootedTmpDirs: string[] = [];
let gateway: Gateway | null = null;

function currentBridgePort(): number {
  return gateway?.getPort() ?? 0;
}

process.on("exit", () => {
  for (const dir of bootedTmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

export interface EnsureCodexBootedArgs {
  frontend?: TalonConfig["frontend"];
  gatewayHandler?: FrontendActionHandler;
  /** Codex model id to run (must be in the curated catalog). */
  model?: string;
}

export async function ensureCodexBooted(
  args: EnsureCodexBootedArgs = {},
): Promise<void> {
  if (booted) return;
  const { frontend = "terminal", gatewayHandler, model = "gpt-5-codex" } = args;

  if (frontend !== "terminal") {
    if (!gatewayHandler) {
      throw new Error(
        `ensureCodexBooted: frontend=${JSON.stringify(frontend)} requires a gatewayHandler.`,
      );
    }
    gateway = new Gateway();
    gateway.setFrontendHandler(gatewayHandler);
    await gateway.start(0);
  }

  if (coreBooted) {
    booted = true;
    return;
  }

  const workspace = mkdtempSync(resolve(tmpdir(), "talon-codex-stub-"));
  bootedTmpDirs.push(workspace);
  initWorkspace(workspace);

  const config: TalonConfig = {
    frontend,
    backend: "codex",
    codexBinary: STUB_BINARY,
    // Bogus base URL so discovery fails fast (ECONNREFUSED) → curated catalog.
    openaiBaseUrl: "http://127.0.0.1:1",
    model,
    maxMessageLength: 4000,
    concurrency: 1,
    pulse: false,
    pulseIntervalMs: 300_000,
    dream: false,
    heartbeat: false,
    heartbeatIntervalMinutes: 60,
    plugins: [],
    botDisplayName: "Talon (codex stub)",
    teamsWebhookPort: 19888,
    teamsGraphPollMs: 10_000,
    systemPrompt: "Test system prompt.",
    workspace,
  } as unknown as TalonConfig;

  const feName = Array.isArray(frontend) ? frontend[0] : frontend;
  const fakeFrontend: Frontend = {
    name: feName,
    context: { acquire: () => {}, release: () => {}, getMessageCount: () => 0 },
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

export function teardownCodexBootstrap(): void {
  if (gateway) {
    void gateway.stop();
    gateway = null;
  }
  booted = false;
}

function syntheticNumericId(stringChatId: string): number {
  let h = 0;
  for (let i = 0; i < stringChatId.length; i++) {
    h = (h * 31 + stringChatId.charCodeAt(i)) >>> 0;
  }
  return h || 1;
}

export interface RunCodexTurnArgs {
  prompt: string;
  script: CodexStubScript;
  chatId?: string;
  senderName?: string;
  isGroup?: boolean;
  resetSession?: boolean;
  bootstrap?: EnsureCodexBootedArgs;
  /**
   * Path to a persistent turn-counter file. Pass the SAME path across multiple
   * `runCodexTurn` calls for one chat to walk a multi-turn script; omit for a
   * fresh counter (turns[0]) each call.
   */
  stateFile?: string;
}

export interface RunCodexTurnResult {
  text: string;
  toolUses: { name: string; input: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  protocolLog: string[];
  tmpDir: string;
}

export async function runCodexTurn(
  args: RunCodexTurnArgs,
): Promise<RunCodexTurnResult> {
  await ensureCodexBooted(args.bootstrap);

  const {
    prompt,
    script,
    chatId = "codex-chat-" + Math.random().toString(36).slice(2, 10),
    senderName = "TestUser",
    isGroup = false,
    resetSession: shouldResetSession = false,
  } = args;

  if (shouldResetSession) resetSession(chatId);

  const tmpDir = mkdtempSync(resolve(tmpdir(), "talon-codex-turn-"));
  const scriptPath = resolve(tmpDir, "script.json");
  const logPath = resolve(tmpDir, "protocol.log");
  const statePath = args.stateFile ?? resolve(tmpDir, "state.counter");
  writeFileSync(scriptPath, JSON.stringify(script));

  process.env.STUB_CODEX_SCRIPT = scriptPath;
  process.env.STUB_CODEX_STATE = statePath;
  process.env.STUB_CODEX_LOG = logPath;
  process.env.STUB_CODEX_TIMEOUT_MS = script.dispatchMcp ? "30000" : "10000";

  const textChunks: string[] = [];
  const toolUses: { name: string; input: Record<string, unknown> }[] = [];

  const numericChatId = gateway ? syntheticNumericId(chatId) : 0;
  if (gateway) gateway.setContext(numericChatId, chatId);

  try {
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
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      protocolLog,
      tmpDir,
    };
  } finally {
    if (gateway) gateway.clearContext(numericChatId);
    delete process.env.STUB_CODEX_SCRIPT;
    delete process.env.STUB_CODEX_STATE;
    delete process.env.STUB_CODEX_LOG;
    delete process.env.STUB_CODEX_TIMEOUT_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
