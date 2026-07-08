/**
 * WarpResolver — turns an incoming turn into the model/backend binding
 * (the warp) it will run on.
 *
 * Owns the whole resolution ladder so the Weaver never sees a partial
 * state: active-model resolution, the send-time null-model guard, and
 * the per-run override (triggers/cron) with its fall-back-to-chat-model
 * safety. The result is a discriminated union — either a bound warp or
 * a refusal with the user-facing message to deliver — so callers can't
 * forget to handle the "no model" case.
 */

import type { ModelRef } from "../agent-runtime/model-ref.js";
import { logDebug, logWarn } from "../../util/log.js";

export type WarpResolverDeps = {
  /**
   * Walks the 5-step active-model resolution chain for the chat. When
   * `model`/`ref` are both `null` (catalog-driven backend with no
   * per-chat pick and no operator default) the turn is refused — see
   * `resolve()`.
   */
  resolveActiveModel: (chatId: string) => Promise<{
    model: string | null;
    ref: ModelRef | null;
    backendId: string;
  }>;
  /**
   * Validates + materialises an explicit per-run model id against the
   * chat's backend. Returns `null` when the id isn't selectable, so
   * the resolver falls back to the chat model. Restricted to the
   * chat's own backend so the session still resumes.
   */
  resolveModelOverride?: (
    chatId: string,
    modelId: string,
  ) => Promise<ModelRef | null>;
};

export type ResolveWarpInput = {
  chatId: string;
  /** Optional per-run model override (triggers/cron). */
  modelOverride?: string;
  /** Turn source, used only for override logging. */
  source: string;
  /** Request id for log correlation. */
  reqId: string;
};

export type WarpResolution =
  | {
      ok: true;
      /** The ModelRef the turn runs on (post-override). */
      ref: ModelRef;
      backendId: string;
      /** A per-run override was applied for this turn. */
      overridden: boolean;
    }
  | {
      ok: false;
      backendId: string;
      /** User-facing refusal ("use /model to pick one"). */
      message: string;
    };

export async function resolveWarp(
  deps: WarpResolverDeps,
  input: ResolveWarpInput,
): Promise<WarpResolution> {
  const { chatId, modelOverride, source, reqId } = input;

  // Send-time null-model guard. When the active-model resolver returns
  // no usable model, refuse to call the backend — it would either error
  // opaquely or run on the wrong default.
  const { model, ref, backendId } = await deps.resolveActiveModel(chatId);
  if (model === null || ref === null) {
    logWarn(
      "dispatcher",
      `[${reqId}] refusing query: no model resolved (chat=${chatId}, backend=${backendId})`,
    );
    return {
      ok: false,
      backendId,
      message:
        `No model selected for backend \`${backendId}\`. ` +
        `Use /model to pick one — or set ` +
        `\`backendDefaults.${backendId}\` in talon.json to apply a ` +
        `default for all chats on this backend.`,
    };
  }

  // Per-run model override (triggers/cron). Resolve against the chat's
  // backend; on success swap the ref for this turn only, on failure fall
  // back to the chat model so a stale override never kills the run.
  let runRef = ref;
  if (modelOverride && deps.resolveModelOverride) {
    try {
      const overrideRef = await deps.resolveModelOverride(
        chatId,
        modelOverride,
      );
      if (overrideRef) {
        runRef = overrideRef;
        logDebug(
          "dispatcher",
          `[${reqId}] model override → ${modelOverride} (${source})`,
        );
      } else {
        logWarn(
          "dispatcher",
          `[${reqId}] model override "${modelOverride}" not resolvable on backend ${backendId}; using chat model`,
        );
      }
    } catch (err) {
      logWarn(
        "dispatcher",
        `[${reqId}] model override resolution threw: ${err instanceof Error ? err.message : String(err)}; using chat model`,
      );
    }
  }

  return { ok: true, ref: runRef, backendId, overridden: runRef !== ref };
}
