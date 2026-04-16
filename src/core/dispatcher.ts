/**
 * Dispatcher — execution path for all AI queries.
 *
 * Manages the lifecycle: acquire context → typing → query → release.
 *
 * Concurrency policy is driven by the backend's `supportsInjection` flag:
 *   • supportsInjection = true (Claude SDK): same-chat dispatches forward in
 *     parallel — the backend keeps one live SDK Query per chat and injects
 *     new messages mid-flight as adjacent turns.
 *   • supportsInjection = false / undefined (OpenCode): same-chat dispatches
 *     are serialized via a per-chat promise chain so a single shared
 *     request/response session isn't corrupted by overlapping calls.
 * Cross-chat queries always run in true parallel.
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

// Per-chat promise chains used only when the backend does NOT support
// mid-flight injection. Prevents two queries from corrupting the same
// session simultaneously on backends like OpenCode.
const chatChains = new Map<string, Promise<unknown>>();

export function initDispatcher(d: DispatcherDeps): void {
  deps = d;
  const mode = d.backend.supportsInjection
    ? "per-chat injection"
    : "per-chat serial";
  log("dispatcher", `Initialized (${mode}, cross-chat parallel)`);
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Number of queries currently running. */
export function getActiveCount(): number {
  return activeCount;
}

/**
 * Execute an AI query with full lifecycle management.
 * Concurrency is determined by the backend's `supportsInjection` flag.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!deps) throw new Error("Dispatcher not initialized");

  // Backends that handle their own per-chat queueing (Claude SDK) get
  // forwarded immediately — same-chat parallelism is desirable so the
  // backend can fold them into one live conversation.
  if (deps.backend.supportsInjection) {
    return run(params);
  }

  // Otherwise serialize same-chat dispatches behind any pending one.
  // Atomic get-or-insert: read and replace in one step to prevent two
  // concurrent calls both seeing the same `prev`.
  const { chatId } = params;
  const prev = chatChains.get(chatId) ?? Promise.resolve();
  // .catch(() => {}) on prev so a previous query's error (already handled
  // by its own caller) doesn't leak as an unhandled rejection here.
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
