# Soul Kernel

Talon's compiled identity. Not a markdown prompt, not a JSON blob — a
**content-addressed Merkle DAG** of typed identity nodes, learned **mechanically**
from behavioral telemetry and projected into the system prompt by **selection**.

> The model is the brain. Talon is the body. The Soul is the persistent identity
> artifact that tells the brain how to be Talon.

## The thesis: the model never writes its own soul

There are two jobs — *being the self* (the reasoning model reads the soul and
acts) and *writing the self* (turning experience into identity). If the reasoning
model does the second, it can rationalize, flatter itself, and confabulate a
coherent self-story that isn't true. So **writing the self is strictly
model-free**: continuous, deterministic, evidence-grounded. The reasoning model is
a *reader* of the soul, never its author. That is the safety property, not just a
cost saving.

The only neural component anywhere is an optional **local embedder** (for
clustering/dedup/contradiction-distance) — a frozen fixed function, not an agent.
Everything else is counters, exponential decay, dot products, and selection.

## The substrate

A node's identity is the sha-256 of its canonical content. The single most
important decision is the split between:

- **Content** (hashed, immutable) — a node's semantic identity: kind + verbatim
  payload + referenced child hashes. A change of content is a new node.
- **State** (mutable, keyed by hash) — salience, evidence weight, activation
  counts. Churns every tick; lives *outside* the Merkle structure.

So reinforcing a value a thousand times never churns a single content hash.
Versioning, provenance, dedup, and partial recompilation fall out structurally;
learning and decay live in the state layer.

## The five structures

| Structure | Node kind | What it is |
|---|---|---|
| Spine | `spine` | append-only causal narrative — *why* Talon became Talon |
| Lattice | `value` + edges | values as evidence clusters; tension/affinity edges self-organize via Hebbian co-activation |
| Reflexes | `reflex` | `trigger → guard → action` rules the harness *enforces* |
| Holograph | `lens` | identity refracted per interlocutor (selection + reweighting) |
| Critic | (classifiers) | frozen feature-based gates over failure modes |

The atoms under all of it are `evidence` nodes — verbatim ground truth. The kernel
never paraphrases; it only ever quotes.

## The model-free pipeline

```
telemetry ──▶ signals ──▶ compiler ──▶ DAG (+ salience/Hebbian) ──▶ projector ──▶ runtime.md
  (harness)   (structured)  (arithmetic)   (content + state)        (selection)   (injected)
```

- **Signals** (`signals.ts`) — structured harness events (reaction, engagement,
  correction, reflex-fire). Interpretation already happened; no transcript reading.
- **Compiler** (`compiler.ts`) — routes each signal to pure update rules. Outcome
  signals reinforce/penalize the values that were live in that turn's projection
  and Hebbian-coactivate them; corrections store verbatim evidence + a Spine event.
- **Salience** (`salience.ts`) — lazy exponential decay, reinforcement, Hebbian
  edges, predictive-coding delta rule. The whole "learning" is here, all arithmetic.
- **Projector** (`projector.ts`) — selects verbatim evidence, salience-ordered
  under a token budget. Reflexes are never budgeted away. The soul cannot
  hallucinate itself.
- **Critic** (`critic.ts`) — frozen classifiers for wall-of-text, sycophancy,
  emoji-overload.
- **Kernel** (`kernel.ts`) — orchestrator: genesis → ingest → commit → project,
  with a git-like commit chain and JSON persistence.

## File map

```
types.ts       node payloads, edges, activation state, commits, config
hash.ts        canonical serialization + content addressing + Merkle root
dag.ts         the DAG store: integrity, dirty propagation, snapshot/restore
salience.ts    decay / reinforce / coactivate / prediction-error  (the math)
reflex.ts      predicate registry + enforcer + the three seed reflexes
signals.ts     structured telemetry types + emoji→valence
compiler.ts    signal → arithmetic update routing  (writing the self)
projector.ts   DAG → runtime surface by selection  (reading the self)
critic.ts      frozen failure-mode classifiers
kernel.ts      orchestrator: lifecycle, commits, persistence
index.ts       public surface
```

## Status

Implemented and tested (61+ tests, model-free end to end): substrate, DAG store,
salience dynamics, reflex enforcer, signals + compiler, projector, kernel
orchestrator + persistence, mechanical Critic.

Next phases: local-embedder integration (clustering evidence → emergent values
with medoid labels, dedup, contradiction/drift distances), relational-holograph
lens compilation from MemPalace + KG, harness wiring (telemetry taps + prompt
injection + reflex enforcement), and the protected-node approval queue.
