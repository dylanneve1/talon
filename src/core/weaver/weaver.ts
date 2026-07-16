/**
 * Weaver — the turn orchestrator. `runTurn` serializes each turn onto
 * its chat's Thread (per-chat FIFO, cross-chat parallel) and drives the
 * turn lifecycle by composing the weaver's single-purpose collaborators:
 *
 *   - `resolveWarp` (warp-resolver.ts) — model/backend binding + the
 *     null-model guard and per-run override fallback;
 *   - `startTypingLoop` (typing-loop.ts) — keeps the frontend's typing
 *     indicator alive for the duration of the turn;
 *   - `prefetchMemory` (memory-prefetch.ts) — optional fail-closed
 *     palace pre-retrieval for live user messages;
 *   - `carryTurnEvents` (shuttle.ts) — pumps the backend's AgentEvent
 *     stream into the frontend sink, settles delivery acks, captures
 *     the result and rethrows error terminators.
 *
 * The Weaver itself only sequences those stages and brackets them with
 * the Thread's execution context — it holds no per-chat state (that's
 * the Thread's) and no policy of its own beyond ordering.
 */

import { randomBytes } from "node:crypto";
import type { Backend } from "../agent-runtime/capabilities.js";
import type { AgentResult } from "../agent-runtime/events.js";
import type { ModelRef } from "../agent-runtime/model-ref.js";
import type { MemoryRetriever } from "../memory/retrieval.js";
import type { ContextManager, ExecuteParams, ExecuteResult } from "../types.js";
import { taskTable, type TaskHandle } from "../tasks/index.js";
import { log, logDebug, logWarn } from "../../util/log.js";
import { Loom } from "./loom.js";
import { prefetchMemory } from "./memory-prefetch.js";
import { carryTurnEvents } from "./shuttle.js";
import type { Thread, ThreadSnapshot } from "./thread.js";
import { startTypingLoop } from "./typing-loop.js";
import { resolveWarp } from "./warp-resolver.js";

export type WeaverDeps = {
  /**
   * Read fresh per call so backend swaps (chat-role rebinds or
   * per-chat overrides via the controller) take effect on the next
   * query without a dispatcher re-init.
   */
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
  /**
   * Optional fire-and-forget hook invoked at the start of every turn,
   * after the warp is bound and before the backend is called. The
   * composition root wires background work here (e.g. dream memory
   * consolidation) so the Weaver stays ignorant of those subsystems.
   * Must not throw and must not block — it is called synchronously.
   */
  onTurnStart?: () => void;
  /**
   * Optional memory pre-retrieval (Phase B). Called for `source: "message"`
   * turns after model/backend resolution and context acquisition, before
   * `runChatTurn(...)`. Fail-closed: errors are logged and the turn runs
   * without injected memory. Absent dep ⇒ prompts byte-identical to before.
   */
  retrieveMemory?: MemoryRetriever;
};

export class Weaver {
  readonly loom: Loom;
  private readonly deps: WeaverDeps;
  private activeCount = 0;

  constructor(deps: WeaverDeps, loom = new Loom()) {
    this.deps = deps;
    this.loom = loom;
  }

  runTurn(params: ExecuteParams): Promise<ExecuteResult> {
    const thread = this.loom.thread(params.chatId);
    // Registered before enqueueing so a turn waiting in its chat's FIFO is
    // visible as `queued` in the task table, not invisible until it runs.
    const task = taskTable.enqueue({
      kind: "turn",
      label: params.source,
      chatId: params.chatId,
    });
    return thread.enqueue(() => this.run(thread, params, task));
  }

  /** Number of turns currently running (not queued) across all chats. */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * A live view of every Thread the Loom is holding — the hub's
   * observability surface for `/status`, drift detection, and remote
   * frontends. Reading is side-effect free.
   */
  snapshot(): ThreadSnapshot[] {
    return this.loom.snapshot();
  }

  private async run(
    thread: Thread,
    params: ExecuteParams,
    task: TaskHandle,
  ): Promise<ExecuteResult> {
    this.activeCount++;
    task.start();
    try {
      const result = await this.executeInner(thread, params, task);
      task.succeed({
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheRead: result.cacheRead,
        cacheWrite: result.cacheWrite,
      });
      return result;
    } catch (err) {
      task.fail(err);
      throw err;
    } finally {
      this.activeCount--;
    }
  }

  private async executeInner(
    thread: Thread,
    params: ExecuteParams,
    task: TaskHandle,
  ): Promise<ExecuteResult> {
    const { context, onActivity, retrieveMemory } = this.deps;
    const backend = this.deps.getBackend(params.chatId);
    const reqId = randomBytes(4).toString("hex");

    const warp = await resolveWarp(this.deps, {
      chatId: params.chatId,
      modelOverride: params.modelOverride,
      source: params.source,
      reqId,
    });
    if (!warp.ok) {
      // Refusals are delivered through the same event sink the backend
      // would use for output (as an `assistant_message` event, so the
      // frontend delivers it normally).
      try {
        await params.onEvent?.({
          type: "assistant_message",
          text: warp.message,
        });
      } catch (err) {
        logWarn(
          "dispatcher",
          `onEvent(no-model) threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return this.emptyResult(warp.message, params);
    }

    // Bind the warp — record the model/backend actually resolved for this turn
    // on the Thread. `weaver.snapshot()` reports it, and a change since the
    // last turn (per-chat rebind, per-run override, or config drift) is logged
    // rather than passing silently.
    const { drifted, previous } = thread.bindWarp({
      model: warp.ref.id,
      backendId: warp.backendId,
      overridden: warp.overridden,
      boundAt: Date.now(),
    });
    task.bind({ model: warp.ref.id, backendId: warp.backendId });
    if (drifted && previous) {
      logDebug(
        "dispatcher",
        `[${reqId}] warp drift chat=${params.chatId}: ${previous.backendId}/${previous.model} → ${warp.backendId}/${warp.ref.id}`,
      );
    }

    this.deps.onTurnStart?.();

    logDebug(
      "dispatcher",
      `[${reqId}] ${params.source} chat=${params.chatId} started (active=${this.activeCount})`,
    );
    context.acquire(params.numericChatId, params.chatId);
    const stopTyping = startTypingLoop(
      this.deps.sendTyping,
      params.numericChatId,
      params.chatId,
    );
    try {
      if (!backend.chat) {
        throw new Error(
          `Backend "${backend.id}" has no chat capability — cannot run a turn.`,
        );
      }

      const retrievedMemory =
        retrieveMemory && params.source === "message"
          ? await prefetchMemory(retrieveMemory, {
              chatId: params.chatId,
              text: params.prompt,
              senderName: params.senderName,
              isGroup: params.isGroup,
              reqId,
            })
          : undefined;

      const stream = backend.chat.runChatTurn({
        chatId: params.chatId,
        model: warp.ref,
        text: params.prompt,
        senderName: params.senderName,
        isGroup: params.isGroup,
        messageId: params.messageId,
        retrievedMemory,
      });
      const agentResult = await carryTurnEvents(stream, params.onEvent);

      onActivity();
      logDebug(
        "dispatcher",
        `[${reqId}] completed in ${agentResult?.durationMs ?? 0}ms ` +
          `(in=${agentResult?.usage.inputTokens ?? 0} out=${agentResult?.usage.outputTokens ?? 0})`,
      );

      return this.toExecuteResult(agentResult, params);
    } finally {
      stopTyping();
      context.release(params.numericChatId, params.chatId);
    }
  }

  private toExecuteResult(
    result: AgentResult | undefined,
    params: ExecuteParams,
  ): ExecuteResult {
    return {
      text: result?.text ?? "",
      durationMs: result?.durationMs ?? 0,
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      cacheRead: result?.usage.cacheRead ?? 0,
      cacheWrite: result?.usage.cacheWrite ?? 0,
      bridgeMessageCount: this.deps.context.getMessageCount(
        params.numericChatId,
        params.chatId,
      ),
    };
  }

  private emptyResult(text: string, params: ExecuteParams): ExecuteResult {
    return {
      text,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      bridgeMessageCount: this.deps.context.getMessageCount(
        params.numericChatId,
        params.chatId,
      ),
    };
  }
}

let weaver: Weaver | null = null;

export function initWeaver(deps: WeaverDeps): Weaver {
  weaver = new Weaver(deps);
  log("dispatcher", "Weaver initialized");
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
