import { randomBytes } from "node:crypto";
import type { Backend } from "../agent-runtime/capabilities.js";
import { AgentRunError, type AgentResult } from "../agent-runtime/events.js";
import type { ModelRef } from "../agent-runtime/model-ref.js";
import { maybeStartDream } from "../background/dream.js";
import type { ContextManager, ExecuteParams, ExecuteResult } from "../types.js";
import { log, logDebug, logWarn } from "../../util/log.js";
import { Loom } from "./loom.js";
import type { Thread, ThreadSnapshot } from "./thread.js";

export type WeaverDeps = {
  getBackend: (chatId?: string) => Backend;
  resolveActiveModel: (chatId: string) => Promise<{
    model: string | null;
    ref: ModelRef | null;
    backendId: string;
  }>;
  resolveModelOverride?: (
    chatId: string,
    modelId: string,
  ) => Promise<ModelRef | null>;
  context: ContextManager;
  sendTyping: (chatId: number, stringId?: string) => Promise<void>;
  onActivity: () => void;
};

export class Weaver {
  readonly loom: Loom;
  private readonly deps: WeaverDeps;

  constructor(deps: WeaverDeps, loom = new Loom()) {
    this.deps = deps;
    this.loom = loom;
  }

  runTurn(params: ExecuteParams): Promise<ExecuteResult> {
    const thread = this.loom.thread(params.chatId);
    return thread.enqueue(() => this.run(thread, params));
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * A live view of every Thread the Loom is holding — the hub's
   * observability surface for `/status`, drift detection, and remote
   * frontends. Reading is side-effect free.
   */
  snapshot(): ThreadSnapshot[] {
    return this.loom
      .chatIds()
      .map((id) => this.loom.get(id)?.describe())
      .filter((s): s is ThreadSnapshot => s !== undefined);
  }

  private activeCount = 0;

  private async run(
    thread: Thread,
    params: ExecuteParams,
  ): Promise<ExecuteResult> {
    this.activeCount++;
    try {
      return await this.executeInner(thread, params);
    } finally {
      this.activeCount--;
    }
  }

  private async executeInner(
    thread: Thread,
    params: ExecuteParams,
  ): Promise<ExecuteResult> {
    const {
      getBackend,
      resolveActiveModel,
      resolveModelOverride,
      context,
      sendTyping,
      onActivity,
    } = this.deps;
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
        bridgeMessageCount: context.getMessageCount(
          params.numericChatId,
          params.chatId,
        ),
      };
    }

    // Per-run model override (triggers/cron). Resolve against the chat's
    // backend; on success swap the ref for this turn only, on failure fall
    // back to the chat model so a stale override never kills the run. The
    // override is restricted to the chat's own backend, so the session still
    // resumes — only the model changes.
    let runRef = resolvedRef;
    if (params.modelOverride && resolveModelOverride) {
      try {
        const overrideRef = await resolveModelOverride(
          params.chatId,
          params.modelOverride,
        );
        if (overrideRef) {
          runRef = overrideRef;
          logDebug(
            "dispatcher",
            `[${reqId}] model override → ${params.modelOverride} (${params.source})`,
          );
        } else {
          logWarn(
            "dispatcher",
            `[${reqId}] model override "${params.modelOverride}" not resolvable on backend ${backendId}; using chat model`,
          );
        }
      } catch (err) {
        logWarn(
          "dispatcher",
          `[${reqId}] model override resolution threw: ${err instanceof Error ? err.message : String(err)}; using chat model`,
        );
      }
    }

    // Bind the warp — record the model/backend actually resolved for this turn
    // on the Thread. `weaver.snapshot()` reports it, and a change since the
    // last turn (per-chat rebind, per-run override, or config drift) is logged
    // rather than passing silently.
    const { drifted, previous } = thread.bindWarp({
      model: runRef.id,
      backendId,
      overridden: runRef !== resolvedRef,
      boundAt: Date.now(),
    });
    if (drifted && previous) {
      logDebug(
        "dispatcher",
        `[${reqId}] warp drift chat=${params.chatId}: ${previous.backendId}/${previous.model} → ${backendId}/${runRef.id}`,
      );
    }

    // Dream check — fire-and-forget background memory consolidation if due
    maybeStartDream();

    logDebug(
      "dispatcher",
      `[${reqId}] ${params.source} chat=${params.chatId} started (active=${this.activeCount})`,
    );
    context.acquire(params.numericChatId, params.chatId);

    let typingTimer: ReturnType<typeof setInterval> | undefined;
    try {
      await sendTyping(params.numericChatId, params.chatId).catch(
        (err: unknown) => {
          logWarn(
            "dispatcher",
            `sendTyping failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
      typingTimer = setInterval(() => {
        sendTyping(params.numericChatId, params.chatId).catch(
          (err: unknown) => {
            logWarn(
              "dispatcher",
              `sendTyping interval failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
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
        model: runRef,
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
        bridgeMessageCount: context.getMessageCount(
          params.numericChatId,
          params.chatId,
        ),
      };
    } finally {
      clearInterval(typingTimer);
      context.release(params.numericChatId, params.chatId);
    }
  }
}

let weaver: Weaver | null = null;

export function initWeaver(deps: WeaverDeps): Weaver {
  weaver = new Weaver(deps);
  log("dispatcher", "Weaver initialized");
  return weaver;
}

export function getWeaver(): Weaver {
  if (!weaver) throw new Error("Weaver not initialized");
  return weaver;
}

/**
 * The active Weaver's Loom, or `null` before the dispatcher is wired. The
 * gateway delegates its per-chat context bookkeeping here so the Loom is the
 * single registry; a standalone gateway (e.g. in unit tests, or during the
 * pre-init startup window) falls back to its own Loom.
 */
export function getActiveLoom(): Loom | null {
  return weaver?.loom ?? null;
}
