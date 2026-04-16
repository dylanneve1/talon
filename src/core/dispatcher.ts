/**
 * Dispatcher — execution path for all AI queries.
 *
 * Manages the lifecycle: acquire context → typing → query → release.
 * True concurrency — every query runs immediately in parallel.
 * No queue, no artificial limits. The Claude API handles its own rate limiting.
 *
 * Concurrency note: same-chat queries used to be serialized here via a
 * per-chat promise chain to prevent two queries from touching the same
 * Claude session at once. The backend now keeps a single live SDK Query
 * per chat and injects new messages mid-flight via streaming input, so
 * concurrent same-chat dispatches are safe and DESIRABLE — they all flow
 * into the same conversation as adjacent turns.
 *
 * Dependencies are injected at startup — this module imports nothing from
 * frontend/ or backend/.
 */

import { randomBytes } from "node:crypto";
import type {
  QueryBackend,
  ContextManager,
  ExecuteParams,
  ExecuteResult,
} from "./types.js";
import { log, logDebug, logWarn } from "../util/log.js";
import { maybeStartDream } from "./dream.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type DispatcherDeps = {
  backend: QueryBackend;
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  onActivity: () => void;
};

let deps: DispatcherDeps | null = null;
let activeCount = 0;

export function initDispatcher(d: DispatcherDeps): void {
  deps = d;
  log("dispatcher", "Initialized (per-chat injection, cross-chat parallel)");
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Number of queries currently running. */
export function getActiveCount(): number {
  return activeCount;
}

/**
 * Execute an AI query with full lifecycle management.
 * Concurrent dispatches for the same chat are forwarded to the backend,
 * which folds them into a single live SDK conversation as separate turns.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!deps) throw new Error("Dispatcher not initialized");
  return run(params);
}

async function run(params: ExecuteParams): Promise<ExecuteResult> {
  activeCount++;
  try {
    return await executeInner(params);
  } finally {
    activeCount--;
  }
}

async function executeInner(params: ExecuteParams): Promise<ExecuteResult> {
  const { backend, context, sendTyping, onActivity } = deps!;
  const reqId = randomBytes(4).toString("hex");

  // Dream check — fire-and-forget background memory consolidation if due
  maybeStartDream();

  logDebug(
    "dispatcher",
    `[${reqId}] ${params.source} chat=${params.chatId} started (active=${activeCount})`,
  );
  context.acquire(params.numericChatId, params.chatId);

  let typingTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await sendTyping(params.numericChatId).catch((err: unknown) => {
      logWarn(
        "dispatcher",
        `sendTyping failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    typingTimer = setInterval(() => {
      sendTyping(params.numericChatId).catch((err: unknown) => {
        logWarn(
          "dispatcher",
          `sendTyping interval failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 4000);

    const result = await backend.query({
      chatId: params.chatId,
      text: params.prompt,
      senderName: params.senderName,
      isGroup: params.isGroup,
      messageId: params.messageId,
      onStreamDelta: params.onStreamDelta,
      onTextBlock: params.onTextBlock,
      onToolUse: params.onToolUse,
    });

    onActivity();

    logDebug(
      "dispatcher",
      `[${reqId}] completed in ${result.durationMs}ms (in=${result.inputTokens} out=${result.outputTokens})`,
    );

    return {
      ...result,
      bridgeMessageCount: context.getMessageCount(params.numericChatId),
    };
  } finally {
    clearInterval(typingTimer);
    context.release(params.numericChatId);
  }
}
