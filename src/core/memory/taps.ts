/**
 * Message taps — the memory store's mechanical input stream.
 *
 * This is the one part of the soul kernel that was worth keeping
 * (docs/memory-persona-plan.md §2): a pair of high-precision regex sets
 * that recognise, without a model call, the two message shapes that carry
 * durable intent — a *directive* ("from now on, …") and a *correction*
 * ("no, that's wrong"). The kernel that consumed them is gone; the rows
 * now land in the typed memory store, where the core view and the
 * retriever already know how to read them.
 *
 * Three rules govern what gets written, and none of them live in the
 * store:
 *
 *   - **Trust comes from the chat.** A DM (or a local terminal/native
 *     session) is the operator typing, so the row is `operator` trust —
 *     stronger than `remember`'s `agent`, because a tap records what a
 *     human literally wrote rather than what the model concluded. A
 *     group — or a chat-id grammar that cannot tell, which fails closed —
 *     is `group_chat`, and a **directive is not recorded there at all**:
 *     durable standing intent only comes from a direct conversation with
 *     the operator. Same rule as the `remember` action.
 *   - **A repeated phrase is not a second memory.** The FTS near-dupe
 *     probe runs before every write, so saying "always use ripgrep" twice
 *     leaves one row, not two.
 *   - **It fails closed and it is never on the prompt-cache path.** Any
 *     store error is one warning and nothing else; the turn proceeds. This
 *     module must not import `core/prompt/invalidation.js` — a tap that
 *     invalidated every live session's prompt snapshot would turn a
 *     ~50-token claim into a 60–90 k cache write (plan §3.6).
 */

import {
  assertMemory,
  findSimilarMemories,
  type MemoryKind,
  type MemorySource,
  type MemoryTrust,
} from "../../storage/memory.js";
import { chatScope } from "../../util/chat-id.js";
import { log, logWarn } from "../../util/log.js";

/**
 * High-precision cues that a message is a *correction* of Talon's behavior. Kept
 * tight on purpose: a false positive stores a claim about how to behave, so we
 * would rather miss a soft correction than mislabel ordinary chat.
 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /^\s*(no|nope|nah)\b[\s,.!:-]/i,
  /\bthat'?s (wrong|incorrect|not (right|correct)|false)\b/i,
  /\b(you'?re|you are) wrong\b/i,
  /\bnot what i (asked|meant|wanted|said)\b/i,
  /\bnever (do|say) that( again)?\b/i,
  /\b(stop|quit) (doing|saying) that\b/i,
  /\bwrong[\s,.!]/i,
  /\byou (messed|screwed|fucked) (that|this|it)? ?up\b/i,
];

/**
 * High-precision cues that a message is a *directive* about how to be — a
 * standing instruction rather than a one-off request. These are stored verbatim
 * as evidence, so again we favor precision over recall.
 */
const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bin (the )?future\b/i,
  /\byou should (always|never)\b/i,
  /\b(always|never) (do|say|reply|respond|answer|use|be|call|check)\b/i,
  /\bi (want|need|'?d like) you to\b/i,
  /\bmake sure (you|to|that)\b/i,
  /\bremember to\b/i,
];

export type MessageClass = "directive" | "correction" | null;

/** `source.actor` on every row this path writes — the ownership marker. */
const TAP_ACTOR = "tap";

/** The subject a tapped directive is filed under: standing operator intent. */
const DIRECTIVE_SUBJECT = "operator";

/** The subject a tapped correction is filed under. */
const CORRECTION_SUBJECT = "correction";

/**
 * Classify a single inbound message. Returns "correction" or "directive" when a
 * cue matches, else null. Corrections are checked first because a correction is
 * the more specific (and more consequential) signal. Very long messages are
 * skipped — standing instructions and corrections are terse.
 */
export function classifyMessage(text: string): MessageClass {
  const t = text.trim();
  if (t.length === 0 || t.length > 500) return null;
  if (CORRECTION_PATTERNS.some((re) => re.test(t))) return "correction";
  if (DIRECTIVE_PATTERNS.some((re) => re.test(t))) return "directive";
  return null;
}

/**
 * The trust tier for something the human typed in this chat. A DM is the
 * operator speaking for themselves; anything multi-party — or a grammar that
 * cannot tell, which fails closed — is `group_chat`.
 */
function trustForChat(chatKey: string): MemoryTrust {
  return chatScope(chatKey) === "dm" ? "operator" : "group_chat";
}

/**
 * How much of two claims' wording must coincide before the tap calls the
 * second one a restatement of the first. Jaccard over the word sets, so
 * word order and punctuation don't matter.
 *
 * A threshold is needed because the tap files every directive under the
 * *same* subject, and the store's FTS probe ORs a claim's terms: "from now
 * on, always use ripgrep" and "from now on, never use emoji" both match it
 * on `from`/`now`/`use`. Without this, the first directive Talon ever heard
 * would swallow every later one. Set high on purpose — the case this
 * exists for is the same sentence typed twice.
 */
const DUPLICATE_OVERLAP = 0.8;

/** The word set of a claim, lowercased, punctuation dropped. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/** Jaccard similarity of two claims' word sets, 0..1. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Write one tapped claim, unless the store already holds a restatement of it
 * under the same kind and subject. Returns true when a row was inserted.
 *
 * The store's FTS probe is the cheap prefilter — live rows only, right kind
 * and subject, best textual match first — and `DUPLICATE_OVERLAP` is the
 * decision.
 */
function storeClaim(
  kind: MemoryKind,
  subject: string,
  text: string,
  trust: MemoryTrust,
  source: MemorySource,
  speaker: string,
): boolean {
  const words = wordSet(text);
  const restated = findSimilarMemories(kind, subject, text).some(
    (row) => overlap(words, wordSet(row.text)) >= DUPLICATE_OVERLAP,
  );
  if (restated) return false;
  const { id } = assertMemory({ kind, subject, text, trust, source });
  log("memory", `tap: [${kind}] ${subject} from ${speaker} #${id}`);
  return true;
}

/**
 * Feed one inbound message to the memory store if it reads as a directive or a
 * correction. Returns the class recognised, whether or not a row was written —
 * a group-chat directive is classified and deliberately dropped.
 *
 * Never throws: the tap runs beside a turn, not inside it, so a store failure
 * costs one warning and nothing else.
 */
export function recordMessageSignal(opts: {
  readonly text: string;
  readonly chatKey: string;
  readonly actor?: string;
}): MessageClass {
  const cls = classifyMessage(opts.text);
  if (cls === null) return null;
  const text = opts.text.trim();
  const trust = trustForChat(opts.chatKey);
  const source: MemorySource = { chat: opts.chatKey, actor: TAP_ACTOR };
  const speaker = opts.actor ?? "user";
  try {
    if (cls === "directive") {
      // A standing instruction only counts when the operator gave it
      // directly — anyone in a group could otherwise plant one.
      if (trust !== "operator") return cls;
      storeClaim("directive", DIRECTIVE_SUBJECT, text, trust, source, speaker);
    } else {
      storeClaim("episode", CORRECTION_SUBJECT, text, trust, source, speaker);
    }
  } catch (err) {
    logWarn("memory", `tap failed to record ${cls}: ${String(err)}`);
  }
  return cls;
}
