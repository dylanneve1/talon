/**
 * Unified delivery routing for the remote-server backend family.
 *
 * Both OpenCode and Kilo can reach the user through one of several paths
 * after a turn completes. The decision tree below is identical between
 * them, so it lives here as a shared helper instead of being duplicated
 * in each handler.
 *
 * Routes:
 *
 *   - `tool` — a delivery tool (`end_turn` / `send` / `react`) already
 *     bridged the message to the platform via `core/tools/messaging.ts`.
 *     The message is already in the chat; we don't re-emit. We may
 *     have captured `deliveredTextNorms` for dedup, or just have
 *     `hadBridgeDelivery` set (e.g. `send(type="photo")` — non-text
 *     bridge delivery).
 *   - `synthetic-error` — the upstream agent server emitted a
 *     `synthetic: true` text part (Kilo's "model hit output limit"
 *     marker, or analogous failure path). Surface as a Talon error
 *     instead of shipping the raw upstream string as a reply.
 *   - `text-part` — model emitted plain assistant text and didn't call
 *     a delivery tool. Ship the part the user hasn't already seen through
 *     `onTextBlock` (see `progress` below).
 *   - `progress` — every line of the reply already reached the user as a
 *     mid-turn progress message, so there is nothing left to send. Recorded
 *     distinctly rather than as `empty`, which means "the model said
 *     nothing at all".
 *   - `empty` — no tool, no text, no synthetic-error. Surface a concise
 *     notice so the user isn't left staring at silence.
 *
 * Output: a `DeliveryDecision` describing which route was taken and how
 * many characters were involved (for logging). The actual emit happens
 * via the injected `onTextBlock` callback when relevant.
 */

import type { StreamState } from "./stream-state.js";
import { undeliveredResponseText } from "./stream-state.js";
import { logWarn } from "../../util/log.js";
import { incrementCounter } from "../../storage/metrics.js";

/** Route the delivery decision selected. */
export type DeliveryRoute =
  "tool" | "text-part" | "progress" | "synthetic-error" | "empty";

export class TextBlockDeliveryError extends Error {
  readonly route: DeliveryRoute;
  readonly chars: number;

  constructor(route: DeliveryRoute, chars: number, cause: unknown) {
    super(
      `text-block delivery failed (${route}, ${chars} chars): ${errMsg(cause)}`,
    );
    this.name = "TextBlockDeliveryError";
    this.route = route;
    this.chars = chars;
    this.cause = cause;
  }
}

export function buildDeliveryFailureReminder(error: TextBlockDeliveryError) {
  return (
    "[DELIVERY FAILURE] Your previous reply was not shown to the user because " +
    `Talon failed while delivering a ${error.route} response (${error.chars} chars): ${errMsg(error.cause)}. ` +
    "Retry now using delivery tools. If the answer is long, split it across " +
    'multiple `send(type="text", text=...)` calls and then call `end_turn()`; ' +
    "or shorten the answer and call `end_turn(text=...)`. Do not write the final " +
    "answer as plain assistant text."
  );
}

/** Outcome of `routeDelivery` — `route` + char count for the log line. */
export interface DeliveryDecision {
  route: DeliveryRoute;
  chars: number;
}

/** Inputs for {@link routeDelivery}. */
export interface RouteDeliveryInputs {
  /** Backend label used in synthetic-error prefix + metric prefix. */
  backendLabel: string;
  /** Chat id for log context. */
  chatId: string;
  /** Accumulated stream state for this turn. */
  state: StreamState;
  /** Finalized response text (from `finalizeResponseText(state)`). */
  responseText: string;
  /** Optional callback to deliver text content to the frontend. */
  onTextBlock?: (text: string) => Promise<void>;
  /**
   * Counter namespace for synthetic-error metric (e.g. `kilo` produces
   * `kilo.synthetic_error`). Defaults to a lower-cased backendLabel.
   */
  metricNamespace?: string;
  /**
   * When true, failed `onTextBlock` delivery is thrown back to the backend so
   * it can re-prompt the model. Default preserves older non-fatal behaviour.
   */
  propagateDeliveryFailure?: boolean;
}

/**
 * Decide which delivery route applies for this turn and (where
 * relevant) emit the content via `onTextBlock`. The decision tree
 * matches Kilo and OpenCode's previous in-handler logic byte-for-byte
 * — extracting it here lets both backends share one implementation.
 *
 * Returns a `DeliveryDecision` for the handler's end-of-turn log line.
 */
export async function routeDelivery(
  inputs: RouteDeliveryInputs,
): Promise<DeliveryDecision> {
  const {
    backendLabel,
    chatId,
    state,
    responseText,
    onTextBlock,
    metricNamespace = backendLabel.toLowerCase(),
    propagateDeliveryFailure = false,
  } = inputs;

  // Route 1 — bridge delivery already happened.
  // A delivery tool already shipped the message. Drop any text-part
  // content — non-Claude models routinely emit a follow-up text part
  // after a tool call containing the model's chain-of-thought
  // commentary, which would surface as a visible double-message.
  // Check both `deliveredTextNorms` (captured for `end_turn` and
  // `send(type="text")` for dedup-by-substring) AND `hadBridgeDelivery`
  // (catches non-text bridge deliveries like `send(type="photo")`
  // which still place a message in chat but carry no text args).
  if (state.deliveredTextNorms.length > 0 || state.hadBridgeDelivery) {
    return {
      route: "tool",
      chars: state.deliveredTextNorms.reduce((n, d) => n + d.length, 0),
    };
  }

  // Route 2 — synthetic error emitted by upstream.
  // The upstream hit an internal failure (e.g. "model hit its output
  // limit while reasoning") and emitted a synthetic text part instead
  // of a real reply. We don't ship the raw upstream string verbatim —
  // it reads as if the model itself answered with technical advice.
  // Convert into a Talon error message.
  if (state.syntheticError && !responseText) {
    incrementCounter(`${metricNamespace}.synthetic_error`);
    logWarn(
      "agent",
      `[${chatId}] ${backendLabel} synthetic error in response: ${formatSyntheticPreview(state.syntheticError)}`,
    );
    if (onTextBlock) {
      try {
        await onTextBlock(`⚠️ ${backendLabel}: ${state.syntheticError}`);
      } catch (err) {
        logWarn(
          "agent",
          `[${chatId}] onTextBlock (synthetic-error) failed: ${errMsg(err)}`,
        );
        if (propagateDeliveryFailure) {
          throw new TextBlockDeliveryError(
            "synthetic-error",
            state.syntheticError.length,
            err,
          );
        }
      }
    }
    return {
      route: "synthetic-error",
      chars: state.syntheticError.length,
    };
  }

  // Route 3 — plain text part. Ship only what the user hasn't already seen.
  //
  // The remote-server backends flush each pre-tool segment through
  // `onTextBlock` as a progress message, and `closeCurrentSegment` also folds
  // that segment into `allResponseText`. Shipping `responseText` wholesale
  // therefore re-sent every narration line a second time, concatenated — the
  // doubled-message symptom on a tool-heavy OpenCode/Kilo turn.
  //
  // The subtraction is gated on a progress send having actually happened.
  // `responseText` is an explicit input and callers are not required to derive
  // it from `state` (several pass a literal), so reading the remainder off
  // `allResponseText` unconditionally would silently drop their reply.
  const pending =
    state.progressDeliveredLen > 0
      ? undeliveredResponseText(state)
      : responseText;
  if (pending && !state.turnTerminated) {
    if (onTextBlock) {
      try {
        await onTextBlock(pending);
      } catch (err) {
        logWarn("agent", `[${chatId}] onTextBlock failed: ${errMsg(err)}`);
        if (propagateDeliveryFailure) {
          throw new TextBlockDeliveryError("text-part", pending.length, err);
        }
      }
    }
    return { route: "text-part", chars: pending.length };
  }

  // Route 3b — the whole reply already reached the user as progress messages.
  // Nothing left to send; recorded distinctly so the turn isn't misfiled as an
  // empty completion in the logs or the empty-turn counter.
  if (responseText && !state.turnTerminated) {
    return { route: "progress", chars: responseText.length };
  }

  // Route 4 — empty turn. The model produced no text (and didn't end_turn):
  // a genuine empty completion, or a tool-only loop that delivered nothing.
  // Stay SILENT — a "(no reply — model returned no output)" placeholder in
  // the chat is slop; a turn with nothing to say should say nothing, exactly
  // like an explicit silent `end_turn()` (Route 5). We still count and log it
  // for observability so systemic empties remain diagnosable from the logs.
  if (
    !state.turnTerminated &&
    !responseText &&
    state.deliveredTextNorms.length === 0
  ) {
    incrementCounter("scratchpad.empty_turn");
    logWarn(
      "agent",
      `[${chatId}] empty turn — no output delivered${
        state.toolCalls > 0
          ? ` (model ran ${state.toolCalls} tool call(s) but produced no text)`
          : " (model returned no output)"
      }; sending nothing.`,
    );
    return { route: "empty", chars: 0 };
  }

  // Edge case: terminated turn with no text and no delivered norms.
  // The model legitimately ended silently (e.g. `end_turn()` with no
  // text). Nothing to send.
  return { route: "tool", chars: 0 };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * One-line preview (~120 chars, whitespace-collapsed) of a synthetic
 * error message for the operator log. Short enough to fit in a tail,
 * long enough to recognise the underlying error category at a glance.
 */
function formatSyntheticPreview(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return JSON.stringify(collapsed);
  return JSON.stringify(collapsed.slice(0, max) + "…");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
