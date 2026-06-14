/**
 * Functional-test bootstrap for the **opencode** (and, by the same wire API,
 * **kilo**) backend against an in-process fake HTTP server
 * (`stub-remote/fake-remote-server.ts`).
 *
 * The backend adopts any server already listening on `OPENCODE_PORT` (probes
 * `/global/health` and reuses it), so we start the fake on a fixed port that
 * the importing test sets via `vi.hoisted` BEFORE the opencode module reads
 * `OPENCODE_PORT` at eval time, then boot the real composition root.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import type { TalonConfig } from "../../util/config.js";
import { initBackendAndDispatcher, type Frontend } from "../../bootstrap.js";
import { execute as dispatcherExecute } from "../../core/engine/dispatcher.js";
import { resetSession } from "../../storage/sessions.js";
import { initWorkspace } from "../../util/workspace.js";
import { Gateway } from "../../core/engine/gateway.js";
import type { FrontendActionHandler } from "../../core/types.js";
import {
  startFakeRemoteServer,
  type FakeRemoteServer,
  type RemoteTurn,
} from "./stub-remote/fake-remote-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.TALON_MCP_SUPERVISOR_CMD = JSON.stringify([
  process.execPath,
  "--import",
  pathToFileURL(
    resolve(__dirname, "../../../node_modules/tsx/dist/esm/index.mjs"),
  ).href,
  resolve(__dirname, "../../cli.ts"),
]);

let booted = false;
let coreBooted = false;
let gateway: Gateway | null = null;
let fakeServer: FakeRemoteServer | null = null;
const bootedTmpDirs: string[] = [];

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

export interface EnsureOpencodeBootedArgs {
  frontend?: TalonConfig["frontend"];
  gatewayHandler?: FrontendActionHandler;
}

export async function ensureOpencodeBooted(
  args: EnsureOpencodeBootedArgs = {},
): Promise<void> {
  if (booted) return;
  const { frontend = "telegram", gatewayHandler } = args;

  if (frontend !== "terminal") {
    if (!gatewayHandler) {
      throw new Error(
        "ensureOpencodeBooted: non-terminal frontend needs a gatewayHandler",
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

  // The opencode module reads OPENCODE_PORT at eval — the test must have set
  // it (vi.hoisted) before importing this module. Start the fake there.
  const fixedPort = Number(process.env.OPENCODE_PORT ?? 0);
  fakeServer = await startFakeRemoteServer(fixedPort);

  const workspace = mkdtempSync(resolve(tmpdir(), "talon-opencode-stub-"));
  bootedTmpDirs.push(workspace);
  initWorkspace(workspace);

  const config: TalonConfig = {
    frontend,
    backend: "opencode",
    model: "stub-model",
    maxMessageLength: 4000,
    concurrency: 1,
    pulse: false,
    pulseIntervalMs: 300_000,
    dream: false,
    heartbeat: false,
    heartbeatIntervalMinutes: 60,
    plugins: [],
    botDisplayName: "Talon (opencode stub)",
    teamsWebhookPort: 19898,
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

export async function teardownOpencodeBootstrap(): Promise<void> {
  if (gateway) {
    void gateway.stop();
    gateway = null;
  }
  if (fakeServer) {
    await fakeServer.stop();
    fakeServer = null;
  }
  booted = false;
  coreBooted = false;
}

function syntheticNumericId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

export interface RunOpencodeTurnArgs {
  prompt: string;
  turn: RemoteTurn;
  chatId?: string;
  senderName?: string;
  isGroup?: boolean;
  resetSession?: boolean;
  bootstrap?: EnsureOpencodeBootedArgs;
}

export interface RunOpencodeTurnResult {
  text: string;
  toolUses: { name: string; input: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  mcpRegistrations: string[];
}

export async function runOpencodeTurn(
  args: RunOpencodeTurnArgs,
): Promise<RunOpencodeTurnResult> {
  await ensureOpencodeBooted(args.bootstrap);
  if (!fakeServer) throw new Error("fake remote server not started");

  const {
    prompt,
    turn,
    chatId = "opencode-chat-" + Math.random().toString(36).slice(2, 10),
    senderName = "TestUser",
    isGroup = false,
    resetSession: shouldResetSession = false,
  } = args;

  if (shouldResetSession) resetSession(chatId);
  fakeServer.setTurn(turn);

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

    return {
      text: textChunks.join(""),
      toolUses,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      mcpRegistrations: fakeServer.mcpRegistrations(),
    };
  } finally {
    if (gateway) gateway.clearContext(numericChatId);
  }
}
