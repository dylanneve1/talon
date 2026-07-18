/**
 * Soul Kernel — the Critic. A self-model of failure modes, made mechanical.
 *
 * In v3 the Critic is not a reasoning model second-guessing the first; it is a
 * set of frozen, feature-based classifiers. Each scores a candidate text (a
 * drafted reply, or a projection surface) against one of Talon's documented
 * failure modes — wall-of-text, sycophancy, emoji-overload — using a linear
 * combination of cheap lexical/structural features and a fixed threshold. A
 * classifier is a fixed function, not an agent, so this stays strictly within
 * the model-free principle.
 *
 * Embedding-based gates (contradiction against the KG, drift from the core
 * centroid) are a later phase; they too are distance comparisons, not model
 * calls. The lexical classifiers here are the immediately-useful, fully
 * dependency-free core.
 */

import { estimateTokens } from "./projector.js";

export type FailureMode = "wall-of-text" | "sycophancy" | "emoji-overload";

export interface CritiqueFeatures {
  readonly tokens: number;
  readonly sentences: number;
  /** Hedging phrases per 100 tokens. */
  readonly hedgeRate: number;
  /** Emoji characters per 100 tokens. */
  readonly emojiDensity: number;
  /** Count of sycophancy-lexicon hits. */
  readonly sycophancyHits: number;
}

export interface Critique {
  readonly mode: FailureMode;
  /** Continuous severity; >= 1 means the fixed threshold was crossed. */
  readonly score: number;
  readonly flagged: boolean;
  readonly reason: string;
}

const HEDGES = [
  "i think",
  "i guess",
  "maybe",
  "perhaps",
  "sort of",
  "kind of",
  "i suppose",
  "probably",
  "it seems",
];

const SYCOPHANCY = [
  "great question",
  "excellent question",
  "you're absolutely right",
  "you are absolutely right",
  "i'd be happy to",
  "i would be happy to",
  "absolutely!",
  "certainly!",
  "of course!",
  "happy to help",
  "great point",
];

// Emoji detection without a heavy dependency: pictographic + symbol ranges.
const EMOJI_RE =
  // Variation selectors are combining marks — alternated separately so the
  // character class holds only standalone pictographic ranges
  // (no-misleading-character-class).
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{1F000}-\u{1F0FF}]|[\u{FE00}-\u{FE0F}]/gu;

function countOccurrences(
  haystack: string,
  needles: readonly string[],
): number {
  let n = 0;
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const i = haystack.indexOf(needle, from);
      if (i === -1) break;
      n++;
      from = i + needle.length;
    }
  }
  return n;
}

/** Extract the cheap features the classifiers run over. Pure + deterministic. */
export function extractFeatures(text: string): CritiqueFeatures {
  const lower = text.toLowerCase();
  const tokens = Math.max(1, estimateTokens(text));
  const sentences = Math.max(1, (text.match(/[.!?](\s|$)/g) ?? []).length);
  const emoji = (text.match(EMOJI_RE) ?? []).length;
  const hedges = countOccurrences(lower, HEDGES);
  return {
    tokens,
    sentences,
    hedgeRate: (hedges / tokens) * 100,
    emojiDensity: (emoji / tokens) * 100,
    sycophancyHits: countOccurrences(lower, SYCOPHANCY),
  };
}

export interface CritiqueThresholds {
  /** Token count above which prose is "wall-of-text". */
  readonly maxTokens: number;
  /** Sycophancy score (hits + hedge contribution) threshold. */
  readonly maxSycophancy: number;
  /** Emoji-per-100-tokens threshold. */
  readonly maxEmojiDensity: number;
}

export const DEFAULT_THRESHOLDS: CritiqueThresholds = {
  maxTokens: 320,
  maxSycophancy: 1,
  maxEmojiDensity: 6,
};

/**
 * Run the frozen classifiers over a candidate text. Returns one critique per
 * failure mode; `flagged` is true when its normalized score reaches 1.
 */
export function critique(
  text: string,
  thresholds: CritiqueThresholds = DEFAULT_THRESHOLDS,
): Critique[] {
  const f = extractFeatures(text);

  const sycophancyScore = f.sycophancyHits + f.hedgeRate / 5;
  const wall = f.tokens / thresholds.maxTokens;
  const syco = sycophancyScore / Math.max(0.0001, thresholds.maxSycophancy);
  const emoji = f.emojiDensity / Math.max(0.0001, thresholds.maxEmojiDensity);

  return [
    {
      mode: "wall-of-text",
      score: wall,
      flagged: wall >= 1,
      reason: `${f.tokens} tokens vs budget ${thresholds.maxTokens}`,
    },
    {
      mode: "sycophancy",
      score: syco,
      flagged: syco >= 1,
      reason: `${f.sycophancyHits} sycophancy hits, hedge ${f.hedgeRate.toFixed(1)}/100tok`,
    },
    {
      mode: "emoji-overload",
      score: emoji,
      flagged: emoji >= 1,
      reason: `${f.emojiDensity.toFixed(1)} emoji/100tok vs ${thresholds.maxEmojiDensity}`,
    },
  ];
}

/** True if any failure mode tripped its threshold. */
export function isFlagged(critiques: readonly Critique[]): boolean {
  return critiques.some((c) => c.flagged);
}
