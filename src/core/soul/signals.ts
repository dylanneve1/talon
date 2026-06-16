/**
 * Soul Kernel — behavioral signals: the fuel.
 *
 * The compiler never reads a transcript and forms an opinion. It consumes
 * *structured* events the harness already emits — reactions, whether a
 * conversation continued or died, corrections, reflex fires. Interpretation has
 * already happened by the time a signal exists, so turning experience into
 * identity stays mechanical.
 *
 * Each outcome signal carries the `activeNodes` that were surfaced in the
 * projection for that turn. That is what closes the loop: project → which values
 * were live → what happened → reinforce or penalize exactly those values.
 */

import type { Hash } from "./types.js";

export interface ReactionSignal {
  readonly kind: "reaction";
  readonly at: number;
  readonly emoji: string;
  /** Value nodes that were live in the projection for the reacted-to turn. */
  readonly activeNodes: readonly Hash[];
}

export interface EngagementSignal {
  readonly kind: "engagement";
  readonly at: number;
  /** Did the conversation continue after Talon's message, or die? */
  readonly continued: boolean;
  readonly activeNodes: readonly Hash[];
  /**
   * Categorical cues observed in the interaction (e.g. emojis used). When
   * present, the outcome teaches each cue's learned valence — meaning comes from
   * data, not a hardcoded table.
   */
  readonly cues?: readonly string[];
}

export interface CorrectionSignal {
  readonly kind: "correction";
  readonly at: number;
  /** The verbatim correction — stored as ground-truth evidence. */
  readonly text: string;
  readonly actor?: string;
  readonly ref?: string;
  /** Values that were live when the correction landed (penalized). */
  readonly activeNodes?: readonly Hash[];
}

export interface DirectiveSignal {
  readonly kind: "directive";
  readonly at: number;
  /** Verbatim instruction about how to be — stored as evidence. */
  readonly text: string;
  readonly actor?: string;
  readonly ref?: string;
}

export interface ReflexFireSignal {
  readonly kind: "reflex-fire";
  readonly at: number;
  readonly name: string;
  readonly severity: "block" | "warn" | "advise";
}

export interface ActivationSignal {
  readonly kind: "activation";
  readonly at: number;
  readonly activeNodes: readonly Hash[];
}

export type Signal =
  | ReactionSignal
  | EngagementSignal
  | CorrectionSignal
  | DirectiveSignal
  | ReflexFireSignal
  | ActivationSignal;

const POSITIVE = new Set([
  "👍",
  "❤",
  "❤️",
  "🔥",
  "🎉",
  "💯",
  "🥰",
  "👏",
  "😁",
  "🤩",
  "🙏",
  "👌",
  "🤝",
  "🫡",
  "😍",
  "🆒",
  "💘",
]);
const NEGATIVE = new Set([
  "👎",
  "😡",
  "🤬",
  "💩",
  "🤮",
  "😢",
  "🖕",
  "🥱",
  "🥴",
  "😴",
]);

/** Map an emoji reaction to a signed valence in {-1, 0, +1}. */
export function emojiValence(emoji: string): number {
  if (POSITIVE.has(emoji)) return 1;
  if (NEGATIVE.has(emoji)) return -1;
  return 0;
}
