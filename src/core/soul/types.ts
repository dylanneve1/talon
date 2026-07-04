/**
 * Soul Kernel — core type system.
 *
 * The Soul is Talon's compiled identity: a content-addressed Merkle DAG of
 * typed nodes, layered with mutable "activation state" (salience, evidence
 * weights) that changes with experience. The reasoning model never *writes*
 * this structure — it is compiled mechanically from behavioral telemetry and a
 * frozen local embedder, then *read* by the model at runtime.
 *
 * The single most important design decision lives here: the split between
 * IMMUTABLE CONTENT and MUTABLE STATE.
 *
 *   - Content  — a node's semantic identity: its kind, its verbatim payload,
 *                and the hashes of the nodes it structurally references. This
 *                is what gets hashed; the hash IS the node's identity. Content
 *                never changes — a change of content is, by definition, a new
 *                node.
 *
 *   - State    — salience, accumulated evidence weight, activation counts,
 *                timestamps. This churns every tick. It is keyed BY the content
 *                hash and lives outside the Merkle structure, so reinforcing a
 *                value a thousand times does not churn a single content hash.
 *
 * Consequence: the structural root hash versions *what Talon is made of*
 * (git-like), while salience is the "weather" layered on top. Rollback,
 * provenance, and dedup fall out of the content layer; learning and decay live
 * in the state layer.
 */

/** A content address: lowercase hex sha-256, prefixed. e.g. "sha256:ab12…". */
export type Hash = string & { readonly __brand: "SoulHash" };

/** The kinds of node the kernel can hold. */
export type NodeKind =
  | "evidence" // a verbatim ground-truth fragment — the atoms
  | "value" // an emergent cluster of evidence (a trait/value)
  | "theme" // a higher-order reflection over co-activating, coherent values
  | "spine" // an append-only developmental-narrative event
  | "reflex" // a compiled behavioral rule (trigger → guard → action)
  | "lens"; // a per-relationship refraction of identity

// ── Node payloads (the hashed content) ───────────────────────────────────────

/**
 * Where a piece of ground truth came from. Provenance is content, not metadata:
 * an evidence node's identity includes *who said it, when, and where*.
 */
export interface EvidenceSource {
  /** Origin channel: a chat correction, a logged event, a diary line, etc. */
  readonly origin:
    | "correction" // someone (usually Dylan) corrected behavior
    | "directive" // an explicit instruction about how to be
    | "event" // something that happened
    | "reaction" // an emoji / engagement signal rendered to text
    | "diary" // a self-written reflection (still ground truth: it was written)
    | "seed"; // hand-seeded at genesis from identity.md / About Me
  /** Free-form locator, e.g. "telegram:msg:4360" or "memory.md#about-me". */
  readonly ref?: string;
  /** Who produced the ground truth, if known (e.g. "dylan"). */
  readonly actor?: string;
}

/** A verbatim fragment of ground truth. The kernel never paraphrases these. */
export interface EvidencePayload {
  readonly kind: "evidence";
  /** The exact text. Never generated, never rewritten. */
  readonly text: string;
  /** When the ground truth was observed (unix ms). Part of identity. */
  readonly observedAt: number;
  readonly source: EvidenceSource;
}

/**
 * An emergent value/trait. Not authored — discovered by clustering evidence
 * embeddings. Its "label" is the medoid: the single most central *real*
 * evidence fragment, never generated prose.
 */
export interface ValuePayload {
  readonly kind: "value";
  /** Hashes of the evidence nodes in this cluster (sorted, deduped). */
  readonly members: readonly Hash[];
  /** The medoid evidence node — the representative real sentence. */
  readonly medoid: Hash;
  /**
   * Optional axis this value sits on, for tension detection. Discovered, not
   * authored — two values on the same axis with high embedding distance but
   * frequent co-activation form a tension edge.
   */
  readonly axis?: string;
}

/**
 * A higher-order reflection: an abstraction over values that are both
 * semantically coherent and frequently co-active. The soul's "higher-level
 * inferences over time" (Generative Agents). Structure is discovered
 * mechanically; the optional `insight` is the ONE place a single gated model
 * pass may write a natural-language label — it can never change which values are
 * grouped, and falls back to the medoid evidence when absent.
 */
export interface ThemePayload {
  readonly kind: "theme";
  /** The value-node hashes this theme abstracts over (sorted, deduped). */
  readonly values: readonly Hash[];
  /** Representative real evidence fragment across all member values. */
  readonly medoid: Hash;
  /** Optional model-written label; absent ⇒ the medoid text is used. */
  readonly insight?: string;
}

/**
 * An append-only developmental-narrative event: the *causal story* of how
 * Talon became Talon. Never rewritten, only appended. Gives continuity of self
 * across resets and model swaps.
 */
export interface SpinePayload {
  readonly kind: "spine";
  /** What happened, verbatim where possible. */
  readonly event: string;
  readonly at: number;
  /** Nodes this event created or reweighted — the causal links. */
  readonly affects: readonly Hash[];
  /** Prior spine node, forming the narrative chain (genesis = undefined). */
  readonly prev?: Hash;
}

/** Severity of a reflex when its guard trips. */
export type ReflexSeverity = "block" | "warn" | "advise";

/**
 * A compiled behavioral rule. The genuinely model-free, *enforceable* core:
 * load-bearing rules become `trigger → guard → action`, checked by the harness,
 * not merely hoped-for from the prompt. Trigger/guard reference a registry of
 * named predicates (see reflex.ts) so they stay pure data, not code.
 */
export interface ReflexPayload {
  readonly kind: "reflex";
  /** Stable human name, e.g. "RULE-0-DELIVERY". */
  readonly name: string;
  /** Named predicate that arms the rule. */
  readonly trigger: string;
  /** Named predicate that, when true under trigger, fires the action. */
  readonly guard: string;
  /** What to do when it fires. */
  readonly action: string;
  readonly severity: ReflexSeverity;
}

/**
 * A per-relationship refraction. Identity is not global — it shows up
 * differently per interlocutor. A lens is a *selection + reweighting*, never
 * generated text: which values amplify, which reflexes tighten, which evidence
 * applies for this person.
 */
export interface LensPayload {
  readonly kind: "lens";
  /** Subject identifier, e.g. "dylan". */
  readonly subject: string;
  /** Value-node hashes to amplify for this subject, with multipliers. */
  readonly amplify: readonly { readonly node: Hash; readonly factor: number }[];
  /** Evidence specific to this relationship. */
  readonly evidence: readonly Hash[];
}

export type NodePayload =
  | EvidencePayload
  | ValuePayload
  | ThemePayload
  | SpinePayload
  | ReflexPayload
  | LensPayload;

/** A node = its hashed content. State lives separately (see ActivationState). */
export interface SoulNode {
  readonly hash: Hash;
  readonly payload: NodePayload;
}

// ── Associative edges (mutable state, NOT hashed) ────────────────────────────

export type EdgeKind =
  | "coactivation" // Hebbian: fired together in a successful interaction
  | "tension" // opposed values frequently co-active (navigated, not resolved)
  | "supersedes"; // one node mechanically overrode another

export interface AssocEdge {
  readonly from: Hash;
  readonly to: Hash;
  readonly kind: EdgeKind;
  /** Learned weight (counts / EMA). Mutable — never part of any content hash. */
  weight: number;
  updatedAt: number;
}

// ── Activation state (mutable, keyed by node hash) ───────────────────────────

/**
 * The "weather" over a node. Reinforced on activation, decayed by time. Drives
 * projection priority. Crucially separate from content so learning never churns
 * the Merkle structure.
 */
export interface ActivationState {
  /** EMA salience in [0, ∞); decays toward 0 without activation. */
  salience: number;
  /**
   * Net evidence weight: positive when behavior expressing this node earns
   * positive signals, negative when it earns corrections. Drives confidence.
   */
  evidence: number;
  /** Number of times activated. */
  activations: number;
  /** Last activation (unix ms) — used by the decay clock. */
  lastActivatedAt: number;
  /**
   * Optional FSRS/DSR memory stability (ms-scale time constant). Present only
   * under adaptive forgetting; grows with successful recall so well-established
   * traits decay slowly and transients fade fast. When absent, decay is the
   * fixed-half-life exponential.
   */
  stability?: number;
}

// ── Commits (the version chain) ──────────────────────────────────────────────

/**
 * A snapshot of identity. Mirrors git: a structural root plus a parent link,
 * plus a digest of the mutable state at commit time (so a rollback restores both
 * structure and weather). Commits form the identity's history.
 */
export interface SoulCommit {
  /** Merkle root over all structural content at this version. */
  readonly root: Hash;
  /** Digest of the activation/edge state captured with this commit. */
  readonly stateDigest: Hash;
  readonly parent?: Hash;
  readonly at: number;
  /** Templated, human-readable summary of what changed (never model-written). */
  readonly summary: string;
}

/** Default kernel tuning. Pure numbers — the whole "compiler" is arithmetic. */
export interface SoulConfig {
  /** Salience reinforcement increment per activation. */
  readonly reinforce: number;
  /** Multiplicative decay applied per decay-clock tick. */
  readonly decay: number;
  /** Half-life of the decay clock in ms (informational; see salience.ts). */
  readonly decayHalfLifeMs: number;
  /**
   * Per-kind decay half-life overrides (ms). Kinds without an entry fall back
   * to `decayHalfLifeMs`. `Number.POSITIVE_INFINITY` disables decay for a kind
   * entirely. The three node families have different temporal properties:
   * reflexes are deliberately seeded behavioral blockers — correct by
   * definition, they must never soften with disuse; evidence (corrections)
   * should fade naturally; spine causal links are context-specific and should
   * go stale faster than traits. See `halfLifeForKind`.
   */
  readonly decayHalfLifeByKindMs?: Partial<Record<NodeKind, number>>;
  /** Hebbian edge increment per co-activation. */
  readonly hebbIncrement: number;
  /** Cosine distance above which two embeddings are "different". */
  readonly clusterDistance: number;
  /** Distance from core centroid above which a mutation is "drift". */
  readonly driftThreshold: number;
  /** Token budget for the runtime projection surface. */
  readonly runtimeBudgetTokens: number;
  /**
   * When true, use FSRS/DSR adaptive forgetting (per-node stability that grows
   * with recall) instead of fixed-half-life exponential decay. Default false to
   * preserve the simple baseline.
   */
  readonly adaptiveForgetting?: boolean;
}

export const DEFAULT_SOUL_CONFIG: SoulConfig = {
  reinforce: 1,
  decay: 0.98,
  decayHalfLifeMs: 1000 * 60 * 60 * 24 * 7, // one week
  decayHalfLifeByKindMs: {
    reflex: Number.POSITIVE_INFINITY, // behavioral blockers never soften
    spine: 1000 * 60 * 60 * 24 * 3.5, // causal links go stale faster than traits
  },
  hebbIncrement: 1,
  clusterDistance: 0.35,
  driftThreshold: 0.55,
  runtimeBudgetTokens: 1200,
};

/**
 * Effective decay half-life for a node kind: the per-kind override when one is
 * configured, otherwise the base `decayHalfLifeMs`. `Number.POSITIVE_INFINITY`
 * means the kind never decays. Callers that don't know the kind (or operate on
 * mixed sets) may omit it and get the base rate.
 */
export function halfLifeForKind(cfg: SoulConfig, kind?: NodeKind): number {
  const override =
    kind === undefined ? undefined : cfg.decayHalfLifeByKindMs?.[kind];
  return override ?? cfg.decayHalfLifeMs;
}
