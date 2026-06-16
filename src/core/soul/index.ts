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
export { retrieveValues, DEFAULT_RETRIEVAL_WEIGHTS } from "./retrieve.js";
export type {
  RetrievedValue,
  RetrievalWeights,
  RetrieveOptions,
} from "./retrieve.js";
export {
  evaluateReflexes,
  evaluateReflex,
  isBlocked,
  seedReflexes,
  BUILTIN_PREDICATES,
} from "./reflex.js";
export type {
  ReflexContext,
  ReflexVerdict,
  ReflexPredicate,
} from "./reflex.js";
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
  retrievability,
  effectiveStrength,
  reinforceFsrs,
  nextStability,
  initialStability,
} from "./forgetting.js";
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
export { deriveFailureModes, assessText } from "./emergent-critic.js";
export type { EmergentFailureMode, FailureRisk } from "./emergent-critic.js";
export { emojiValence } from "./signals.js";
export type { Signal } from "./signals.js";
export { ValenceModel } from "./valence.js";
export type { ValenceSnapshot } from "./valence.js";
export { Adwin } from "./drift.js";
export type { AdwinChange } from "./drift.js";
export { diffSnapshots, renderDelta, explainDelta } from "./delta.js";
export type { SoulDelta } from "./delta.js";
export { ApprovalQueue } from "./governance.js";
export type {
  Proposal,
  ProposalStatus,
  ApprovalSnapshot,
} from "./governance.js";
export {
  CompositionalMemory,
  symbolVector,
  bind,
  bundle,
  permute,
  cleanup,
  hdCosine,
  DEFAULT_HD_DIM,
} from "./hdc.js";
export type { Hypervector } from "./hdc.js";
export {
  HashingEmbedder,
  cosineSimilarity,
  cosineDistance,
  normalize,
  centroid,
  medoidIndex,
  dot,
  norm,
} from "./embedder.js";
export type { Embedder } from "./embedder.js";
export { TalonEmbedder } from "./talon-embedder.js";
export type { TalonEmbedderOptions } from "./talon-embedder.js";
export {
  resolveSoulSettings,
  soulEnabled,
  DEFAULT_SOUL_SETTINGS,
} from "./settings.js";
export type { SoulSettings } from "./settings.js";
export { clusterEvidence } from "./cluster.js";
export type { Embedded, EvidenceCluster } from "./cluster.js";
export { detectTensions, tensionPairs } from "./lattice.js";
export type { TensionOptions } from "./lattice.js";
export { associativeRecall, prime } from "./associative.js";
export type {
  RecallResult,
  RecallOptions,
  PrimeOptions,
} from "./associative.js";
export { pagerank } from "./centrality.js";
export type { PageRankOptions } from "./centrality.js";
export { consolidate, liveValues, isSuperseded } from "./consolidate.js";
export type { ConsolidateOptions, ConsolidateResult } from "./consolidate.js";
export { reflect } from "./reflect.js";
export { compileLens, liveLens } from "./lens.js";
export type { LensOptions } from "./lens.js";
export type { ReflectOptions, ReflectResult } from "./reflect.js";
export {
  hashContent,
  hashPayload,
  canonicalize,
  merkleRoot,
  isHash,
} from "./hash.js";
export * from "./types.js";
