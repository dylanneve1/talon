/**
 * Soul Kernel — the orchestrator.
 *
 * Wraps the DAG with a commit chain and persistence, and exposes the public
 * lifecycle: genesis → ingest(signal)* → commit → project. The reasoning model
 * touches only `project()` (read); everything that *writes* identity is the
 * mechanical compiler.
 *
 * Commits mirror git: each bundles the structural Merkle root, a digest of the
 * mutable state at that instant, and a parent link, so a rollback restores both
 * the structure and the "weather". Summaries are templated from the dirty set —
 * never model-written.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SoulDag, type DagSnapshot } from "./dag.js";
import { hashContent } from "./hash.js";
import { ingest, ingestAll, appendSpine, type IngestResult } from "./compiler.js";
import { Adwin } from "./drift.js";
import { projectRuntime, type Projection } from "./projector.js";
import { seedReflexes } from "./reflex.js";
import { clusterEvidence } from "./cluster.js";
import { consolidate, type ConsolidateResult } from "./consolidate.js";
import { reflect, type ReflectOptions, type ReflectResult } from "./reflect.js";
import { compileLens } from "./lens.js";
import { detectTensions } from "./lattice.js";
import { ValenceModel, type ValenceSnapshot } from "./valence.js";
import {
  ApprovalQueue,
  type ApprovalSnapshot,
  type Proposal,
} from "./governance.js";
import { retrieveValues, type RetrievalWeights } from "./retrieve.js";
import { pagerank } from "./centrality.js";
import {
  associativeRecall,
  type RecallOptions,
  type RecallResult,
} from "./associative.js";
import type { Embedder } from "./embedder.js";
import type { Signal } from "./signals.js";
import {
  DEFAULT_SOUL_CONFIG,
  type Hash,
  type NodePayload,
  type SoulCommit,
  type SoulConfig,
} from "./types.js";

const PERSIST_VERSION = 1;

interface PersistShape {
  readonly version: number;
  readonly config: SoulConfig;
  readonly dag: DagSnapshot;
  readonly commits: readonly SoulCommit[];
  readonly valence?: ValenceSnapshot;
  readonly drift?: readonly number[];
  readonly approvals?: ApprovalSnapshot;
}

export interface GenesisOptions {
  readonly config?: SoulConfig;
  readonly now?: number;
  /** Optional founding directives, each seeded as a single-evidence value. */
  readonly seedValues?: readonly { text: string; actor?: string }[];
}

export class SoulKernel {
  private constructor(
    private readonly dag: SoulDag,
    readonly config: SoulConfig,
    private readonly commits: SoulCommit[],
    private readonly valenceModel: ValenceModel = new ValenceModel(),
    private readonly drift: Adwin = new Adwin(),
    private readonly approvals: ApprovalQueue = new ApprovalQueue(),
  ) {}

  // ── Governance (protected mutations) ─────────────────────────────────────────

  /**
   * Propose a protected mutation (e.g. a new reflex or core value). It does NOT
   * take effect — it queues for human approval, so load-bearing identity can
   * never drift silently.
   */
  propose(payload: NodePayload, reason: string, now = Date.now()): Proposal {
    return this.approvals.propose(payload, reason, now);
  }

  /** Pending protected proposals awaiting a decision. */
  pendingApprovals(): Proposal[] {
    return this.approvals.pending();
  }

  /** Approve a pending proposal and materialize it in the DAG. Caller commits. */
  approve(id: string, now = Date.now()): Hash | undefined {
    const payload = this.approvals.resolve(id, true, now);
    if (!payload) return undefined;
    return this.dag.addNode(payload, now);
  }

  /** Reject a pending proposal; nothing is applied. */
  reject(id: string, now = Date.now()): boolean {
    this.approvals.resolve(id, false, now);
    return this.approvals.get(id)?.status === "rejected";
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** A fresh kernel with the load-bearing reflexes installed. */
  static genesis(opts: GenesisOptions = {}): SoulKernel {
    const config = opts.config ?? DEFAULT_SOUL_CONFIG;
    const now = opts.now ?? Date.now();
    const dag = new SoulDag();
    for (const reflex of seedReflexes()) dag.addNode(reflex, now);
    const kernel = new SoulKernel(dag, config, []);
    for (const seed of opts.seedValues ?? []) {
      kernel.addSeedValue(seed.text, now, seed.actor);
    }
    kernel.commit("genesis", now);
    return kernel;
  }

  /**
   * Seed a founding value from a verbatim directive: one evidence node, wrapped
   * in a single-member value whose medoid is itself. Later clustering (embedder
   * phase) may merge such seeds into larger values.
   */
  addSeedValue(text: string, now = Date.now(), actor?: string): Hash {
    const evidence = this.dag.addNode(
      {
        kind: "evidence",
        text,
        observedAt: now,
        source: { origin: "seed", ...(actor ? { actor } : {}) },
      },
      now,
    );
    return this.dag.addNode(
      { kind: "value", members: [evidence], medoid: evidence },
      now,
    );
  }

  // ── Write (mechanical) ───────────────────────────────────────────────────────

  ingest(signal: Signal): IngestResult {
    // Engagement outcomes teach the valence model what its cues actually mean.
    if (signal.kind === "engagement" && signal.cues?.length) {
      const outcome = signal.continued ? 1 : -1;
      for (const cue of signal.cues) this.valenceModel.observe(cue, outcome);
    }
    const result = ingest(this.dag, signal, this.config, (c) =>
      this.valenceModel.valence(c),
    );
    this.trackDrift(signal);
    return result;
  }

  /**
   * Feed an interaction's scalar outcome to ADWIN; a detected distribution shift
   * is a developmental inflection, recorded as an epoch in the Spine.
   */
  private trackDrift(signal: Signal): void {
    let outcome: number | undefined;
    if (signal.kind === "engagement") outcome = signal.continued ? 1 : -1;
    else if (signal.kind === "reaction") outcome = this.valenceModel.valence(signal.emoji);
    else if (signal.kind === "correction") outcome = -1;
    if (outcome === undefined) return;

    const change = this.drift.add(outcome);
    if (change.changed) {
      appendSpine(
        this.dag,
        `Epoch: behavioral reception shifted (${change.meanBefore!.toFixed(2)} → ${change.meanAfter!.toFixed(2)})`,
        signal.at,
      );
    }
  }

  ingestAll(signals: readonly Signal[]): IngestResult[] {
    return signals.map((s) => this.ingest(s));
  }

  /** The learned cue→valence model (meaning discovered from outcomes). */
  valence(): ValenceModel {
    return this.valenceModel;
  }

  /**
   * Evidence not yet absorbed into any value — the raw material awaiting
   * clustering. Membership and medoid roles both count as "claimed".
   */
  private looseEvidence(): Hash[] {
    const claimed = new Set<Hash>();
    for (const node of this.dag.nodesOfKind("value")) {
      if (node.payload.kind !== "value") continue;
      claimed.add(node.payload.medoid);
      for (const m of node.payload.members) claimed.add(m);
    }
    const out: Hash[] = [];
    for (const node of this.dag.nodesOfKind("evidence")) {
      if (!claimed.has(node.hash)) out.push(node.hash);
    }
    return out;
  }

  /**
   * Crystallize loose evidence into emergent values: embed the unabsorbed
   * fragments, cluster them by cosine geometry, and materialize a value node per
   * cluster with the medoid as its verbatim label. The model names nothing —
   * geometry discovers the values. Returns the value hashes created. Caller
   * commits.
   */
  async crystallize(embedder: Embedder, now = Date.now()): Promise<Hash[]> {
    const loose = this.looseEvidence();
    if (loose.length === 0) return [];

    const texts = loose.map((h) => {
      const node = this.dag.getNode(h);
      return node?.payload.kind === "evidence" ? node.payload.text : "";
    });
    const vectors = await embedder.embed(texts);
    const embedded = loose.map((hash, i) => ({ hash, vector: vectors[i]! }));
    const clusters = clusterEvidence(embedded, this.config.clusterDistance);

    const created: Hash[] = [];
    for (const cl of clusters) {
      const value = this.dag.addNode(
        { kind: "value", members: [...cl.members].sort(), medoid: cl.medoid },
        now,
      );
      created.push(value);
    }
    return created;
  }

  /**
   * The organic maintenance pass — Talon's "dream". Runs the full mechanical
   * growth cycle in order: crystallize loose evidence into values, let the
   * lattice reorganize (merge drifted-together values, migrating learned state),
   * then recompute tensions. Everything here is geometry + arithmetic; no model.
   * Returns a small summary. Caller commits.
   */
  async dream(
    embedder: Embedder,
    opts?: { now?: number; tension?: { minCoactivation: number; minDistance: number } },
  ): Promise<{
    crystallized: number;
    consolidated: ConsolidateResult;
    tensions: number;
    themes: number;
  }> {
    const now = opts?.now ?? Date.now();
    const crystallized = await this.crystallize(embedder, now);
    const consolidated = await consolidate(this.dag, embedder, this.config, {
      now,
    });
    const tension = opts?.tension ?? { minCoactivation: 3, minDistance: 0.5 };
    const tensions = await detectTensions(this.dag, embedder, {
      ...tension,
      now,
    });
    const reflected = await reflect(this.dag, embedder, this.config, { now });
    return {
      crystallized: crystallized.length,
      consolidated,
      tensions: tensions.length,
      themes: reflected.created.length,
    };
  }

  /**
   * Form higher-order themes over the value graph (Generative-Agents
   * reflection, model-free). Pass `synthesize` only if you want the optional,
   * label-only gated model pass. Caller commits.
   */
  async reflect(
    embedder: Embedder,
    opts?: Partial<ReflectOptions> & { now?: number },
  ): Promise<ReflectResult> {
    return reflect(this.dag, embedder, this.config, {
      now: opts?.now ?? Date.now(),
      ...(opts?.affinity !== undefined ? { affinity: opts.affinity } : {}),
      ...(opts?.embeddingWeight !== undefined
        ? { embeddingWeight: opts.embeddingWeight }
        : {}),
      ...(opts?.synthesize ? { synthesize: opts.synthesize } : {}),
    });
  }

  /**
   * Compile (or recompile) the lens for a subject from actor-tagged evidence —
   * how Talon refracts for that person. Supersedes the prior lens. Caller
   * commits. Returns the lens hash or undefined if the subject has no evidence.
   */
  compileLens(
    subject: string,
    opts?: { now?: number; boost?: number; maxEvidence?: number },
  ): Hash | undefined {
    return compileLens(this.dag, subject, {
      now: opts?.now ?? Date.now(),
      ...(opts?.boost !== undefined ? { boost: opts.boost } : {}),
      ...(opts?.maxEvidence !== undefined ? { maxEvidence: opts.maxEvidence } : {}),
    });
  }

  /** Run a single consolidation pass directly. Caller commits. */
  async consolidate(
    embedder: Embedder,
    opts?: { now?: number; mergeThreshold?: number },
  ): Promise<ConsolidateResult> {
    return consolidate(this.dag, embedder, this.config, {
      now: opts?.now ?? Date.now(),
      ...(opts?.mergeThreshold !== undefined
        ? { mergeThreshold: opts.mergeThreshold }
        : {}),
    });
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  project(opts?: { now?: number; lens?: string }): Projection {
    return projectRuntime(this.dag, {
      now: opts?.now ?? Date.now(),
      config: this.config,
      lens: opts?.lens,
    });
  }

  /**
   * Context-conditioned projection (Generative-Agents retrieval): surfaces the
   * values most relevant to the current moment, not just the globally salient
   * ones. Async because relevance embeds the context against value medoids.
   */
  async projectFor(
    embedder: Embedder,
    opts: {
      context?: string;
      now?: number;
      lens?: string;
      weights?: RetrievalWeights;
    },
  ): Promise<Projection> {
    const now = opts.now ?? Date.now();
    const ranked = await retrieveValues(this.dag, embedder, {
      now,
      config: this.config,
      centrality: pagerank(this.dag),
      ...(opts.context !== undefined ? { context: opts.context } : {}),
      ...(opts.weights ? { weights: opts.weights } : {}),
    });
    return projectRuntime(this.dag, {
      now,
      config: this.config,
      ...(opts.lens !== undefined ? { lens: opts.lens } : {}),
      order: ranked.map((r) => r.hash),
    });
  }

  /**
   * Associative recall (modern Hopfield): the constellation of values bound to
   * the cues by co-activation, as a one-step softmax. Read-only.
   */
  recall(cues: Hash[], opts?: RecallOptions): RecallResult[] {
    return associativeRecall(this.dag, cues, opts ?? {});
  }

  graph(): SoulDag {
    return this.dag;
  }

  history(): readonly SoulCommit[] {
    return this.commits;
  }

  head(): SoulCommit | undefined {
    return this.commits[this.commits.length - 1];
  }

  // ── Commit ───────────────────────────────────────────────────────────────────

  /** Digest of the mutable state, so commits capture the weather, not just structure. */
  private stateDigest(): Hash {
    const snap = this.dag.snapshot();
    return hashContent({
      state: snap.state
        .map(([h, s]) => [h, s.salience, s.evidence, s.activations] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
      edges: snap.edges
        .map((e) => [e.from, e.kind, e.to, e.weight] as const)
        .sort(),
    });
  }

  /**
   * Snapshot the current identity as a commit. The summary is templated from the
   * count of dirty nodes — deterministic, never authored.
   */
  commit(reason: string, now = Date.now()): SoulCommit {
    const dirty = this.dag.dirtySet().size;
    const commit: SoulCommit = {
      root: this.dag.root(),
      stateDigest: this.stateDigest(),
      parent: this.head()?.root,
      at: now,
      summary: `${reason}: ${this.dag.size} nodes, ${dirty} touched`,
    };
    this.commits.push(commit);
    this.dag.clearDirty();
    return commit;
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  toJSON(): PersistShape {
    return {
      version: PERSIST_VERSION,
      config: this.config,
      dag: this.dag.snapshot(),
      commits: [...this.commits],
      valence: this.valenceModel.snapshot(),
      drift: this.drift.snapshot(),
      approvals: this.approvals.snapshot(),
    };
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.toJSON()), "utf8");
  }

  static fromJSON(data: PersistShape): SoulKernel {
    if (data.version !== PERSIST_VERSION) {
      throw new Error(`SoulKernel: unsupported persist version ${data.version}`);
    }
    return new SoulKernel(
      SoulDag.restore(data.dag),
      data.config,
      [...data.commits],
      data.valence ? ValenceModel.restore(data.valence) : new ValenceModel(),
      data.drift ? Adwin.restore(data.drift) : new Adwin(),
      data.approvals ? ApprovalQueue.restore(data.approvals) : new ApprovalQueue(),
    );
  }

  static load(path: string): SoulKernel {
    return SoulKernel.fromJSON(JSON.parse(readFileSync(path, "utf8")));
  }
}
