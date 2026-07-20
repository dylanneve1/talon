/**
 * Per-chat conversation memory for the OpenAI Agents backend.
 *
 * The SDK's `MemorySession` preserves every model output, tool call,
 * and tool result across turns — that's what gives the model session
 * memory without us having to mirror it ourselves. What it does NOT
 * do is bound the cost of that memory: a chat that takes several
 * screenshots will quickly accumulate megabytes of base64 image data
 * that gets replayed back to the model on every subsequent turn,
 * blowing through the context window and confusing small models that
 * lose the through-line under a wall of repeated payloads.
 *
 * `TalonSession` plugs that gap by composing the SDK's session with:
 *
 *   1. A pipeline of {@link SessionItemTransform}s that rewrite stored
 *      items before they're replayed to the model. The default
 *      pipeline elides embedded media (image / file payloads) since
 *      Telegram already received the deliverable; the model only
 *      needs the *narrative* (it called the tool, it got something
 *      back). New transforms — say, truncating noisy Bash output —
 *      can be added without touching this class.
 *
 *   2. A {@link CapacityPolicy} that bounds the stored item count and
 *      evicts the oldest items in pairs, so `function_call` items
 *      never get separated from their matching `function_call_result`
 *      across the eviction line (some providers reject orphaned
 *      pairs).
 *
 * Storage-side fidelity is preserved: `getItems()` returns items
 * exactly as the SDK stored them. Only the model-input path (via
 * `prepareHistoryItemForModelInput`) gets the transformed view.
 *
 * The SDK clones items via `structuredClone` on every `addItems` and
 * `getItems` call, so any approach that relies on object-identity
 * tracking across those boundaries is broken by design — that's why
 * transforms run on every replay rather than only on items "old
 * enough" to elide. Stripping every historical media payload is
 * correct anyway: by the time an item is in storage, the turn that
 * produced it has already completed and the user has already received
 * the deliverable.
 */

import { MemorySession } from "@openai/agents";
import type { AgentInputItem } from "@openai/agents";
import { incrementCounter } from "../../util/metrics.js";

// ── Public types ───────────────────────────────────────────────────────────

/**
 * One stateless rewrite step in the replay pipeline.
 *
 * Implementations should be pure (no I/O, no captured state) and
 * idempotent — they may be invoked many times per turn and across
 * many turns. Returning the input reference unchanged when there's
 * nothing to do allows callers to skip downstream clone costs.
 */
export interface SessionItemTransform {
  /** Stable identifier — used in metrics + debugging. */
  readonly name: string;
  /** Return the item to replay to the model. May be the same reference. */
  apply(item: AgentInputItem): AgentInputItem;
}

/** Constructor options for {@link TalonSession}. */
export interface TalonSessionOptions {
  sessionId?: string;
  /**
   * Maximum number of items the session will retain before evicting
   * older entries. Eviction is pair-aware (see {@link enforceCap}).
   */
  maxItems?: number;
  /**
   * Replay-time transforms applied in order. Each transform may
   * rewrite the item or pass it through. Defaults to a single
   * {@link MediaStripperTransform}.
   */
  transforms?: SessionItemTransform[];
}

// ── Defaults ───────────────────────────────────────────────────────────────

/**
 * 200 items ≈ ~50 typical turns (user message + several tool
 * call/result pairs + assistant message). Generous for natural
 * conversation, bounded enough that a long-lived bot doesn't grow its
 * RAM footprint without limit.
 */
const DEFAULT_MAX_ITEMS = 200;

/**
 * Kept short — the goal is to strip bytes from the replay payload
 * without losing the structural hint that a media artifact existed.
 */
const ELIDED_MEDIA_PLACEHOLDER =
  "[media omitted from history — already delivered to chat]";

// ── Built-in transforms ────────────────────────────────────────────────────

/**
 * Replaces embedded media (image / file / input_image / input_file
 * content) with a short text placeholder. The most common offender is
 * `browser_take_screenshot` results, which carry hundreds of KB of
 * base64 PNG data per call.
 */
export class MediaStripperTransform implements SessionItemTransform {
  readonly name = "media-stripper";

  apply(item: AgentInputItem): AgentInputItem {
    if (!item || typeof item !== "object") return item;

    const t = (item as { type?: string }).type;

    // Tool results — the biggest offender. `output` is string | block | block[].
    if (t === "function_call_result") {
      const r = item as { output?: unknown };
      const next = this.stripOutput(r.output);
      if (next === r.output) return item;
      incrementCounter("session.media_stripped.function_call_result");
      return { ...item, output: next } as AgentInputItem;
    }

    // Assistant + user messages may also carry image content.
    const role = (item as { role?: string }).role;
    if (role === "assistant" || role === "user") {
      const m = item as { content?: unknown };
      if (Array.isArray(m.content)) {
        let mutated = false;
        const next = m.content.map((b) => {
          const out = this.stripBlock(b);
          if (out !== b) mutated = true;
          return out;
        });
        if (mutated) {
          incrementCounter(`session.media_stripped.${role}_message`);
          return { ...item, content: next } as AgentInputItem;
        }
      }
    }

    return item;
  }

  private stripOutput(output: unknown): unknown {
    if (output == null) return output;
    if (typeof output === "string") return output;
    if (Array.isArray(output)) {
      let mutated = false;
      const next = output.map((b) => {
        const out = this.stripBlock(b);
        if (out !== b) mutated = true;
        return out;
      });
      return mutated ? next : output;
    }
    if (typeof output === "object") {
      const single = this.stripBlock(output);
      return single === output ? output : single;
    }
    return output;
  }

  private stripBlock(block: unknown): unknown {
    if (!block || typeof block !== "object") return block;
    const t = (block as { type?: string }).type;
    if (
      t === "image" ||
      t === "input_image" ||
      t === "file" ||
      t === "input_file"
    ) {
      return { type: "text", text: ELIDED_MEDIA_PLACEHOLDER } as const;
    }
    return block;
  }
}

// ── Capacity policy ────────────────────────────────────────────────────────

/**
 * Compute the slice index where eviction should start (inclusive),
 * given an item list and a max-items target. Returns 0 when no
 * eviction is needed.
 *
 * Extends the drop boundary if it would split a function_call from
 * its matching function_call_result. Worst case we drop a few items
 * more than strictly necessary — acceptable in exchange for never
 * breaking provider invariants around tool-call pairing.
 */
export function computeEvictionBoundary(
  items: ReadonlyArray<AgentInputItem>,
  maxItems: number,
): number {
  if (items.length <= maxItems) return 0;

  let dropCount = items.length - maxItems;
  while (dropCount < items.length) {
    const lastDropped = items[dropCount - 1];
    const firstKept = items[dropCount];
    if (!splitsFunctionCallPair(lastDropped, firstKept)) break;
    dropCount += 1;
  }
  return dropCount;
}

function splitsFunctionCallPair(
  lastDropped: AgentInputItem | undefined,
  firstKept: AgentInputItem | undefined,
): boolean {
  if (!lastDropped || !firstKept) return false;
  const droppedType = (lastDropped as { type?: string }).type;
  const keptType = (firstKept as { type?: string }).type;
  if (
    droppedType === "function_call" &&
    keptType === "function_call_result" &&
    (lastDropped as { callId?: string }).callId ===
      (firstKept as { callId?: string }).callId
  ) {
    return true;
  }
  return false;
}

// ── Session ────────────────────────────────────────────────────────────────

/**
 * Talon's session wrapper. Inherits SDK behaviour and adds:
 *
 *   - replay-time item transforms (default: media stripping),
 *   - bounded storage with pair-aware eviction.
 */
export class TalonSession extends MemorySession {
  private readonly transforms: SessionItemTransform[];
  private readonly maxItems: number;

  constructor(options: TalonSessionOptions = {}) {
    super({ sessionId: options.sessionId });
    this.transforms = options.transforms ?? [new MediaStripperTransform()];
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  }

  /**
   * Invoked by the runner before replaying a stored item to the
   * model. Runs the transform pipeline in order; each step may
   * rewrite or pass through.
   */
  prepareHistoryItemForModelInput(item: AgentInputItem): AgentInputItem {
    let current = item;
    for (const transform of this.transforms) {
      current = transform.apply(current);
    }
    return current;
  }

  override async addItems(items: AgentInputItem[]): Promise<void> {
    await super.addItems(items);
    await this.enforceCap();
  }

  /**
   * Trim the stored list to {@link maxItems} when it exceeds the cap,
   * extending the cut to preserve function-call / function-call-result
   * pairs (see {@link computeEvictionBoundary}).
   *
   * Implemented as full read + clear + re-add because
   * {@link MemorySession} doesn't expose a bulk-replace primitive.
   * Only runs when over cap, so amortised cost stays low.
   */
  private async enforceCap(): Promise<void> {
    const all = await super.getItems();
    const dropCount = computeEvictionBoundary(all, this.maxItems);
    if (dropCount === 0) return;
    const kept = all.slice(dropCount);
    await super.clearSession();
    await super.addItems(kept);
    incrementCounter("session.items_evicted", dropCount);
  }
}
