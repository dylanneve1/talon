/**
 * Dispatcher — single execution path for all AI queries.
 *
 * Manages the lifecycle: queue → acquire context → typing → query → release.
 * Uses p-queue for global concurrency control — prevents spawning too many
 * SDK processes simultaneously.
 *
 * Dependencies are injected at startup — this module imports nothing from
 * frontend/ or backend/.
 */

import PQueue from "p-queue";
import type {
  QueryBackend,
  ContextManager,
  ExecuteParams,
  ExecuteResult,
} from "./types.js";
import { log } from "../util/log.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type DispatcherDeps = {
  backend: QueryBackend;
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  onActivity: () => void;
  /** Max concurrent AI queries (default 3) */
  concurrency?: number;
};

let deps: DispatcherDeps | null = null;
let queue: PQueue | null = null;

export function initDispatcher(d: DispatcherDeps): void {
  deps = d;
  const concurrency = d.concurrency ?? 3;
  queue = new PQueue({ concurrency });
  log("dispatcher", `Initialized (concurrency=${concurrency})`);
}

// ── Public API ──────────────────────────────────────────────────────────────

export function isBusy(): boolean {
  return deps?.context.isBusy() ?? false;
}

/** Number of queries currently running + waiting. */
export function getQueueSize(): number {
  return queue ? queue.size + queue.pending : 0;
}

/**
 * Execute an AI query with full lifecycle management.
 * Queued with global concurrency control. Acquires tool-execution context,
 * manages typing indicator, runs the query, and releases context.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!deps || !queue) throw new Error("Dispatcher not initialized");

  return queue.add(() => executeInner(params), {
    // p-queue wraps our return type
  }) as Promise<ExecuteResult>;
}

async function executeInner(params: ExecuteParams): Promise<ExecuteResult> {
  const { backend, context, sendTyping, onActivity } = deps!;

  context.acquire(params.numericChatId);

  let typingTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await sendTyping(params.numericChatId).catch(() => {});
    typingTimer = setInterval(() => {
      sendTyping(params.numericChatId).catch(() => {});
    }, 4000);

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
    if (typingTimer) clearInterval(typingTimer);
    context.release(params.numericChatId);
  }
}
