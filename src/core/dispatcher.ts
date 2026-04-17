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

import type {
  QueryBackend,
  ContextManager,
  ExecuteParams,
  ExecuteResult,
} from "./types.js";
import {
  log,
  logDebug,
  logWarn,
  newRequestId,
  childLogger,
} from "../util/log.js";
import { withSpan } from "../util/trace.js";
import { incrementCounter, recordHistogram } from "../util/metrics.js";
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
  const reqId = newRequestId();
  const logCtx = childLogger({
    component: "dispatcher",
    reqId,
    chatId: params.chatId,
    source: params.source,
  });

  // Dream check — fire-and-forget background memory consolidation if due
  maybeStartDream();

  return withSpan(
    "dispatcher.execute",
    {
      reqId,
      chatId: params.chatId,
      source: params.source,
      numericChatId: params.numericChatId,
    },
    async (span) => {
      logCtx.debug(
        `${params.source} chat=${params.chatId} started (active=${activeCount})`,
      );
      incrementCounter("dispatcher.queries");
      incrementCounter(`dispatcher.source.${params.source}`);
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

        span.addEvent("backend-query-start");
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
        span.addEvent("backend-query-end");
        span.setAttributes({
          durationMs: result.durationMs,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheRead: result.cacheRead,
          cacheWrite: result.cacheWrite,
        });
        recordHistogram("dispatcher.duration.ms", result.durationMs);
        if (result.inputTokens !== undefined)
          recordHistogram("tokens.input", result.inputTokens);
        if (result.outputTokens !== undefined)
          recordHistogram("tokens.output", result.outputTokens);

        onActivity();

        logCtx.debug(
          `completed in ${result.durationMs}ms (in=${result.inputTokens} out=${result.outputTokens})`,
        );
        incrementCounter("dispatcher.queries.ok");

        return {
          ...result,
          bridgeMessageCount: context.getMessageCount(params.numericChatId),
        };
      } catch (err) {
        incrementCounter("dispatcher.queries.error");
        logCtx.error(`query failed`, err);
        throw err;
      } finally {
        clearInterval(typingTimer);
        context.release(params.numericChatId);
      }
    },
  );
}
