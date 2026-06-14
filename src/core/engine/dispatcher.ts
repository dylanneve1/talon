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
import type { ContextManager, ExecuteParams, ExecuteResult } from "../types.js";
import type { Backend } from "../agent-runtime/capabilities.js";
import { AgentRunError, type AgentResult } from "../agent-runtime/events.js";
import { log, logDebug, logWarn } from "../../util/log.js";
import { maybeStartDream } from "../background/dream.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

/**
 * `getBackend` takes the string chat id so it can route per-chat —
 * a chat with a backend override returns its override backend, others
 * fall through to the global chat-role backend. Tests can pass a
 * stub that ignores the chat id. See `core/backend-controller.ts`.
 *
 * `resolveActiveModel` walks the 5-step active-model resolution
 * chain for the chat and returns both the resolved `ModelRef` and
 * the raw string + backend id. When `ref` and `model` are both
 * `null`, the dispatcher refuses to call the backend and replies
 * with a "use /model to pick one" message — submitting an empty
 * model id would either error opaquely or run on the wrong default.
 */
type DispatcherDeps = {
  getBackend: (chatId?: string) => Backend;
  resolveActiveModel: (chatId: string) => Promise<{
    model: string | null;
    ref: import("../agent-runtime/model-ref.js").ModelRef | null;
    backendId: string;
  }>;
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
  // returns no usable model (catalog-driven backend with no per-chat
  // pick and no operator default), refuse to call the backend — it
  // would either error opaquely or run on the wrong default. Reply
  // with a clear "use /model to pick one" message routed through the
  // same event sink the backend would use for output (as an
  // `assistant_message` event, so the frontend delivers it normally).
  const {
    model: resolvedModel,
    ref: resolvedRef,
    backendId,
  } = await resolveActiveModel(params.chatId);
  if (resolvedModel === null || resolvedRef === null) {
    const message =
      `No model selected for backend \`${backendId}\`. ` +
      `Use /model to pick one — or set ` +
      `\`backendDefaults.${backendId}\` in talon.json to apply a ` +
      `default for all chats on this backend.`;
    logWarn(
      "dispatcher",
      `[${reqId}] refusing query: no model resolved (chat=${params.chatId}, backend=${backendId})`,
    );
    try {
      await params.onEvent?.({ type: "assistant_message", text: message });
    } catch (err) {
      logWarn(
        "dispatcher",
        `onEvent(no-model) threw: ${err instanceof Error ? err.message : String(err)}`,
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

    // Consume the backend's native `AgentEvent` stream and forward
    // every event straight to the frontend's `onEvent` sink (no
    // callback bridge). Capture the `completed` event's `AgentResult`
    // for the dispatcher's return value, and rethrow an `error`
    // terminator as `AgentRunError` so callers' catch paths keep
    // working. Events are awaited in stream order so a consumer that
    // needs serial delivery gets it.
    if (!backend.chat) {
      throw new Error(
        `Backend "${backend.id}" has no chat capability — cannot run a turn.`,
      );
    }
    const stream = backend.chat.runChatTurn({
      chatId: params.chatId,
      model: resolvedRef,
      text: params.prompt,
      senderName: params.senderName,
      isGroup: params.isGroup,
      messageId: params.messageId,
    });
    let agentResult: AgentResult | undefined;
    for await (const event of stream) {
      if (event.type === "completed") {
        agentResult = event.result;
      }

      // The dispatcher owns `assistant_message.deliveryAck` settlement
      // so it is ALWAYS resolved — even when no `onEvent` sink is
      // supplied, or the sink ignores the event. Otherwise the
      // callback-shaped backend (handler-to-events) blocks forever
      // awaiting delivery confirmation. The frontend's job is just to
      // deliver and throw on failure; the dispatcher maps that onto the
      // ack (resolve on success → block delivered; reject on throw →
      // backend retries, e.g. Codex oversized-message path).
      if (event.type === "assistant_message" && event.deliveryAck) {
        try {
          await params.onEvent?.(event);
          event.deliveryAck.resolve();
        } catch (err) {
          event.deliveryAck.reject(err);
        }
        continue;
      }

      await params.onEvent?.(event);
      if (event.type === "error") {
        throw new AgentRunError(event.error);
      }
    }
    const result = {
      text: agentResult?.text ?? "",
      durationMs: agentResult?.durationMs ?? 0,
      inputTokens: agentResult?.usage.inputTokens ?? 0,
      outputTokens: agentResult?.usage.outputTokens ?? 0,
      cacheRead: agentResult?.usage.cacheRead ?? 0,
      cacheWrite: agentResult?.usage.cacheWrite ?? 0,
    };

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
