/**
 * Soul Kernel — public surface.
 *
 * Talon's compiled identity: a content-addressed Merkle DAG of evidence, values,
 * spine, reflexes, and lenses, learned mechanically from behavioral telemetry and
 * projected into the system prompt by selection. The reasoning model reads the
 * soul; it never writes it.
 *
 * Typical lifecycle:
 *
 *   const soul = SoulKernel.genesis({ seedValues: [...] });
 *   soul.ingest({ kind: "correction", at, text, activeNodes });
 *   soul.commit("nightly");
 *   const { text } = soul.project({ lens: "dylan" });   // inject `text`
 */

export { SoulKernel } from "./kernel.js";
export type { GenesisOptions } from "./kernel.js";
export { SoulDag, structuralChildren } from "./dag.js";
export { projectRuntime, estimateTokens } from "./projector.js";
export type { Projection, ProjectionOptions } from "./projector.js";
export {
  evaluateReflexes,
  evaluateReflex,
  isBlocked,
  seedReflexes,
  BUILTIN_PREDICATES,
} from "./reflex.js";
export type { ReflexContext, ReflexVerdict, ReflexPredicate } from "./reflex.js";
export {
  reinforce,
  coactivate,
  applyPredictionError,
  effectiveSalience,
  confidence,
  decayFactor,
} from "./salience.js";
export { ingest, ingestAll, appendSpine } from "./compiler.js";
export type { IngestResult } from "./compiler.js";
export {
  critique,
  extractFeatures,
  isFlagged,
  DEFAULT_THRESHOLDS,
} from "./critic.js";
export type {
  Critique,
  CritiqueFeatures,
  CritiqueThresholds,
  FailureMode,
} from "./critic.js";
export { emojiValence } from "./signals.js";
export type { Signal } from "./signals.js";
export {
  hashContent,
  hashPayload,
  canonicalize,
  merkleRoot,
  isHash,
} from "./hash.js";
export * from "./types.js";
