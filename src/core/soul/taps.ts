/**
 * Soul Kernel — runtime taps.
 *
 * The thin glue that turns live runtime events into kernel signals. The kernel
 * itself never reads a transcript; it consumes *structured* events the harness
 * already produces. This module is where those events are recognized and handed
 * to {@link SoulService}.
 *
 * Everything here is gated on the soul being enabled (`getSoul().enabled`). When
 * it's off, every function is a cheap no-op and nothing is tracked or allocated
 * beyond the empty maps — so a deployment without a soul behaves byte-identically.
 *
 * Two responsibilities:
 *   1. Remember which messages Talon *itself* sent, so a later reaction update
 *      can be attributed to one of our own messages. A reaction to Talon is
 *      feedback about Talon; a reaction to someone else's message is not.
 *   2. Classify inbound user text that is addressed to Talon into directives and
 *      corrections, using high-precision mechanical heuristics (no model).
 */

import { getSoul } from "./service.js";
import { log } from "../../util/log.js";

// ── Bot-message memory ───────────────────────────────────────────────────────

/**
 * Per-chat bounded ring of recently-sent bot message IDs. Telegram's
 * `message_reaction` update tells us *which* message was reacted to but not who
 * authored it, so we keep a small FIFO of our own outgoing IDs and attribute a
 * reaction only when it lands on one of them. Bounded so a long-lived process
 * never grows this without limit.
 */
const RING_PER_CHAT = 200;
const botMessages = new Map<string, number[]>();

/**
 * The action names that produce a *new* outgoing bot message worth tracking.
 * Deliberately excludes `react`, `edit_message`, `pin_message`, etc.: those
 * either return someone else's message id or mutate an existing one, so crediting
 * a reaction to them would be wrong.
 */
export const BOT_MESSAGE_ACTIONS: ReadonlySet<string> = new Set([
  "send_message",
  "reply_to",
  "send_message_with_buttons",
  "send_file",
  "send_photo",
  "send_video",
  "send_animation",
  "send_voice",
  "send_audio",
  "send_sticker",
  "send_poll",
  "send_location",
  "send_contact",
  "send_dice",
  "copy_message",
  "forward_message",
]);

/** Record that Talon sent a message, so a later reaction can be attributed. */
export function noteBotMessage(chatId: string | number, msgId: number): void {
  if (!getSoul().enabled) return;
  if (!Number.isFinite(msgId) || msgId <= 0) return;
  const key = String(chatId);
  const ring = botMessages.get(key) ?? [];
  if (ring.includes(msgId)) return;
  ring.push(msgId);
  if (ring.length > RING_PER_CHAT) ring.shift();
  botMessages.set(key, ring);
}

/** True when `msgId` is one of Talon's own recently-sent messages in this chat. */
export function isBotMessage(chatId: string | number, msgId: number): boolean {
  return botMessages.get(String(chatId))?.includes(msgId) ?? false;
}

/** Drop all tracked bot messages (tests / explicit reset). */
export function resetBotMessages(): void {
  botMessages.clear();
}

// ── Reaction tap ─────────────────────────────────────────────────────────────

/** A `ReactionType`-shaped item from Telegram's reaction arrays. */
export interface ReactionTypeLike {
  readonly type: string;
  readonly emoji?: string;
}

/**
 * The emojis present in `next` but not in `prev` — i.e. reactions just *added*.
 * Custom and paid reactions (no `.emoji`) are ignored; only standard emoji carry
 * a valence the kernel understands.
 */
export function newlyAddedEmojis(
  prev: readonly ReactionTypeLike[],
  next: readonly ReactionTypeLike[],
): string[] {
  const before = new Set(
    prev.filter((r) => r.type === "emoji" && r.emoji).map((r) => r.emoji),
  );
  return next
    .filter((r) => r.type === "emoji" && r.emoji && !before.has(r.emoji))
    .map((r) => r.emoji as string);
}

/**
 * A user added reactions to one of Talon's messages → reinforce/penalize the
 * values that were on stage when that message was produced. No-op unless the
 * soul is on, at least one emoji was added, and the target is a tracked bot
 * message.
 */
export function recordReactionToBot(
  chatId: string | number,
  msgId: number,
  addedEmojis: readonly string[],
): boolean {
  if (!getSoul().enabled) return false;
  if (addedEmojis.length === 0) return false;
  if (!isBotMessage(chatId, msgId)) return false;
  for (const emoji of addedEmojis) getSoul().recordReaction(emoji);
  log("soul", `reaction ${addedEmojis.join(" ")} on bot msg ${msgId}`);
  return true;
}

// ── Directive / correction tap ───────────────────────────────────────────────

/**
 * High-precision cues that a message is a *correction* of Talon's behavior. Kept
 * tight on purpose: a false positive penalizes whatever values were on stage, so
 * we would rather miss a soft correction than mislabel ordinary chat.
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
 * Feed an inbound message to the kernel if it is addressed to Talon and reads as
 * a directive or correction. Returns the class recorded (or null). No-op unless
 * the soul is on.
 */
export function recordMessageSignal(opts: {
  readonly text: string;
  readonly actor?: string;
  readonly addressedToBot: boolean;
}): MessageClass {
  if (!getSoul().enabled) return null;
  if (!opts.addressedToBot) return null;
  const cls = classifyMessage(opts.text);
  const text = opts.text.trim();
  if (cls === "correction") {
    getSoul().recordCorrection(text, opts.actor);
    log("soul", `correction recorded from ${opts.actor ?? "user"}`);
  } else if (cls === "directive") {
    getSoul().recordDirective(text, opts.actor);
    log("soul", `directive recorded from ${opts.actor ?? "user"}`);
  }
  return cls;
}
