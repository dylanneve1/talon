/**
 * Dispatcher — execution path for all AI queries.
 *
 * Manages the lifecycle: acquire context → typing → query → release.
 * True concurrency — every query runs immediately in parallel.
 * No queue, no artificial limits. The Claude API handles its own rate limiting.
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
import { classify } from "./errors.js";
import { log, logDebug, logError, logWarn } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
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

// Per-chat promise chains — serializes within a chat, parallel across chats.
// Prevents two queries from resuming the same Claude session simultaneously.
const chatChains = new Map<string, Promise<unknown>>();

export function initDispatcher(d: DispatcherDeps): void {
  deps = d;
  log("dispatcher", "Initialized (per-chat serial, cross-chat parallel)");
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Number of queries currently running. */
export function getActiveCount(): number {
  return activeCount;
}

/**
 * Execute an AI query with full lifecycle management.
 * Same-chat queries are serialized (FIFO) to avoid session conflicts.
 * Different-chat queries run in true parallel.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!deps) throw new Error("Dispatcher not initialized");

  const { chatId } = params;

  // Chain this query behind any pending query for the same chat.
  // Atomic get-or-insert: read and replace in one step to prevent
  // two concurrent calls both seeing the same `prev`.
  const prev = chatChains.get(chatId) ?? Promise.resolve();
  // Use .catch(() => {}) on prev to prevent unhandled rejections —
  // previous query's error is already handled by its own caller.
  const queued = prev.catch(() => {}).then(() => run(params));
  chatChains.set(chatId, queued); // must happen before any await

  // Clean up chain entry when this is the last in the chain
  queued
    .catch(() => {})
    .finally(() => {
      if (chatChains.get(chatId) === queued) chatChains.delete(chatId);
    });

  return queued;
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

    let result: Awaited<ReturnType<QueryBackend["query"]>>;
    try {
      result = await backend.query({
        chatId: params.chatId,
        text: params.prompt,
        senderName: params.senderName,
        isGroup: params.isGroup,
        messageId: params.messageId,
        onStreamDelta: params.onStreamDelta,
        onTextBlock: params.onTextBlock,
        onToolUse: params.onToolUse,
      });
    } catch (err) {
      const classified = classify(err);
      logError("dispatcher", `[${reqId}] backend query failed`, classified, {
        reqId,
        chatId: params.chatId,
        source: params.source,
        reason: classified.reason,
        retryable: classified.retryable,
      });
      recordError(
        `Dispatcher query failed (${classified.reason}): ${classified.message}`,
      );
      throw classified;
    }

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
