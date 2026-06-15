/**
 * Backend-agnostic functional-test harness.
 *
 * `createStubHarness(adapter)` boots the REAL composition root
 * (`initBackendAndDispatcher`) once, wires a live `Gateway` + recording action
 * handler (so MCP tool calls route through the production SDK→MCP→bridge→gateway
 * chain), and drives turns through the production `dispatcher.execute()`. The
 * adapter supplies only the transport-specific stub.
 *
 * One harness instance == one backend booted in the test's module/worker. Call
 * it once at the top of a test file and reuse `runTurn` across cases.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

import type { TalonConfig } from "../../../util/config.js";
import { initBackendAndDispatcher, type Frontend } from "../../../bootstrap.js";
import { execute as dispatcherExecute } from "../../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../../core/agent-runtime/events.js";
import { resetSession } from "../../../storage/sessions.js";
import { initWorkspace } from "../../../util/workspace.js";
import { Gateway } from "../../../core/engine/gateway.js";
import {
  makeRecordingHandler,
  type RecordingHandler,
} from "../recording-handler.js";
import type {
  StubBackendAdapter,
  StubTurnResult,
  ToolUseRecord,
} from "./types.js";

export interface RunTurnArgs<Turn> {
  prompt: string;
  /** Backend-specific script for this single dispatcher turn. */
  turn: Turn;
  chatId?: string;
  senderName?: string;
  isGroup?: boolean;
  /** Reset session bookkeeping for this chat first (default true). */
  resetSession?: boolean;
}

export interface StubHarness<Turn> {
  /** Drive one production turn against the stubbed backend. */
  runTurn(args: RunTurnArgs<Turn>): Promise<StubTurnResult>;
  /** The gateway's recording handler — assert on captured actions. */
  readonly recording: RecordingHandler;
  /** Stop the gateway + adapter resources. Call from `afterAll`. */
  teardown(): Promise<void>;
}

function syntheticNumericId(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h || 1;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Point Talon's MCP supervisor at a Talon entry that can dispatch the
 * `_mcp-launch` subcommand. Under vitest, `process.argv[1]` is vitest's entry,
 * which can't — so route through `cli.ts` via tsx. Backend-agnostic; set once.
 */
function ensureMcpSupervisorCmd(): void {
  if (process.env.TALON_MCP_SUPERVISOR_CMD) return;
  process.env.TALON_MCP_SUPERVISOR_CMD = JSON.stringify([
    process.execPath,
    "--import",
    pathToFileURL(
      resolve(__dirname, "../../../../node_modules/tsx/dist/esm/index.mjs"),
    ).href,
    resolve(__dirname, "../../../cli.ts"),
  ]);
}

export function createStubHarness<Turn>(
  adapter: StubBackendAdapter<Turn>,
  options: { recordingSeed?: number } = {},
): StubHarness<Turn> {
  const recording = makeRecordingHandler({ seed: options.recordingSeed });
  const gateway = new Gateway();
  gateway.setFrontendHandler(recording.handler);

  let booted: Promise<void> | null = null;
  const tmpDirs: string[] = [];

  const boot = async (): Promise<void> => {
    ensureMcpSupervisorCmd();
    await gateway.start(0);

    // Adapter setup MUST precede `initBackendAndDispatcher` — backend factory
    // modules read their port/auth env at import time, and that import happens
    // inside the composition root.
    await adapter.prepare?.();

    const workspace = mkdtempSync(
      resolve(tmpdir(), `talon-${adapter.id}-stub-`),
    );
    tmpDirs.push(workspace);
    initWorkspace(workspace);

    const config: TalonConfig = {
      frontend: "telegram",
      backend: adapter.id,
      model: adapter.model,
      maxMessageLength: 4000,
      concurrency: 1,
      pulse: false,
      pulseIntervalMs: 300_000,
      dream: false,
      heartbeat: false,
      heartbeatIntervalMinutes: 60,
      plugins: [],
      botDisplayName: `Talon (${adapter.id} stub)`,
      teamsWebhookPort: 19890,
      teamsGraphPollMs: 10_000,
      systemPrompt: "Test system prompt.",
      workspace,
      ...adapter.configOverrides?.(),
    } as unknown as TalonConfig;

    const frontend: Frontend = {
      name: "telegram",
      context: {
        acquire: () => {},
        release: () => {},
        getMessageCount: () => 0,
      },
      sendTyping: async () => {},
      sendMessage: async () => {},
      getBridgePort: () => gateway.getPort(),
      init: async () => {},
      start: async () => {},
      stop: async () => {},
    };
    await initBackendAndDispatcher(config, frontend);
  };

  const runTurn = async (args: RunTurnArgs<Turn>): Promise<StubTurnResult> => {
    if (!booted) booted = boot();
    await booted;

    const {
      prompt,
      turn,
      chatId = `${adapter.id}-chat-` + Math.random().toString(36).slice(2, 10),
      senderName = "TestUser",
      isGroup = false,
      resetSession: shouldReset = true,
    } = args;

    if (shouldReset) resetSession(chatId);

    const tmpDir = mkdtempSync(resolve(tmpdir(), `talon-${adapter.id}-turn-`));
    const ctx = { chatId, tmpDir };
    await adapter.applyTurn(turn, ctx);

    const textChunks: string[] = [];
    const toolUses: ToolUseRecord[] = [];
    const numericChatId = syntheticNumericId(chatId);
    gateway.setContext(numericChatId, chatId);

    try {
      const result = await dispatcherExecute({
        chatId,
        numericChatId,
        prompt,
        senderName,
        isGroup,
        source: "message",
        onEvent: async (event) => {
          switch (event.type) {
            case "assistant_message":
              textChunks.push(event.text);
              break;
            case "tool_call":
              toolUses.push({
                name: event.name,
                input: toolInputToRecord(event.name, event.input),
              });
              break;
          }
        },
      });

      return {
        text: textChunks.join(""),
        toolUses,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        extras: adapter.collectExtras?.(ctx) ?? {},
      };
    } finally {
      gateway.clearContext(numericChatId);
      adapter.afterTurn?.(ctx);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  const teardown = async (): Promise<void> => {
    await gateway.stop().catch(() => {});
    await adapter.teardown?.();
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  return { runTurn, recording, teardown };
}
