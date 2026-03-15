/**
 * Dispatcher — single execution path for all AI queries.
 *
 * Manages the lifecycle: acquire context → typing → query backend → release.
 * All callers (handlers, pulse, cron) go through here instead of touching
 * the backend or bridge directly.
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

// ── Dependencies (injected at startup) ──────────────────────────────────────

type DispatcherDeps = {
  backend: QueryBackend;
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  onActivity: () => void;
};

let deps: DispatcherDeps | null = null;

export function initDispatcher(d: DispatcherDeps): void {
  deps = d;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isBusy(): boolean {
  return deps?.context.isBusy() ?? false;
}

/**
 * Execute an AI query with full lifecycle management.
 * Acquires tool-execution context, manages typing indicator,
 * runs the query, and releases context on completion.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!deps) throw new Error("Dispatcher not initialized");

  const { backend, context, sendTyping, onActivity } = deps;

  context.acquire(params.numericChatId);

  // Typing indicator with 4-second keepalive
  await sendTyping(params.numericChatId).catch(() => {});
  const typingTimer = setInterval(() => {
    sendTyping(params.numericChatId).catch(() => {});
  }, 4000);

  try {
    const result = await backend.query({
      chatId: params.chatId,
      text: params.prompt,
      senderName: params.senderName,
      isGroup: params.isGroup,
      messageId: params.messageId,
      onStreamDelta: params.onStreamDelta,
      onTextBlock: params.onTextBlock,
    });

    onActivity();

    return {
      ...result,
      bridgeMessageCount: context.getMessageCount(),
    };
  } finally {
    clearInterval(typingTimer);
    context.release(params.numericChatId);
  }
}
