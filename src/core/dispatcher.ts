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
import { log, logDebug, logWarn } from "../util/log.js";
import { maybeStartDream } from "./dream.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

/**
 * `getBackend` takes the string chat id so it can route per-chat —
 * a chat with a backend override returns its override backend, others
 * fall through to the global chat-role backend. Tests can pass a
 * stub that ignores the chat id. See `core/backend-controller.ts`.
 *
 * `resolveActiveModel` walks the 5-step active-model resolution
 * chain for the chat. Returns `null` when no model is selected AND
 * no operator default exists — the dispatcher then refuses to call
 * `backend.query` and replies with a "use /model to pick one"
 * message. Optional — if omitted (legacy/test path) the send guard
 * is skipped and every query passes through.
 */
type DispatcherDeps = {
  getBackend: (chatId?: string) => QueryBackend;
  resolveActiveModel?: (
    chatId: string,
  ) => Promise<{ model: string | null; backendId: string }>;
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
  const { getBackend, resolveActiveModel, context, sendTyping, onActivity } =
    deps!;
  // Read the backend fresh per call so backend swaps (chat-role
  // rebinds or per-chat overrides via the controller) take effect on
  // the next query without a dispatcher re-init.
  const backend = getBackend(params.chatId);
  const reqId = randomBytes(4).toString("hex");

  // Send-time null-model guard. When the active-model resolver
  // returns null (catalog-driven backend with no per-chat pick and
  // no operator default), refuse to call backend.query — most
  // backends would either error opaquely or submit an empty model id
  // to the CLI. Reply with a clear "use /model to pick one" message
  // routed through the same onTextBlock callback the backend would
  // use for output. Bypassed entirely when deps don't include the
  // resolver (legacy / test path).
  if (resolveActiveModel) {
    const { model, backendId } = await resolveActiveModel(params.chatId);
    if (model === null) {
      const message =
        `No model selected for backend \`${backendId}\`. ` +
        `Use /model to pick one — or set ` +
        `\`backendDefaults.${backendId}\` in talon.json to apply a ` +
        `default for all chats on this backend.`;
      logWarn(
        "dispatcher",
        `[${reqId}] refusing query: no model resolved (chat=${params.chatId}, backend=${backendId})`,
      );
      // Emit the message via the same callback the backend would use
      // for text output, so the frontend delivers it through the
      // normal path (no special-casing required at the call site).
      try {
        await params.onTextBlock?.(message);
      } catch (err) {
        logWarn(
          "dispatcher",
          `onTextBlock(no-model) threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        text: message,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        bridgeMessageCount: context.getMessageCount(params.numericChatId),
      };
    }
  }

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
