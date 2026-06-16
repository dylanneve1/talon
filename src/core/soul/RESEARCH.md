# Soul Kernel — research grounding

Every mechanism in the kernel is model-free, but few are invented. This maps the
load-bearing ideas to the literature they come from, and notes where each lives.

## Implemented

### Content-addressed Merkle DAG — `hash.ts`, `dag.ts`
- Merkle, "A Digital Signature Based on a Conventional Encryption Function" (1987);
  the git object model (Torvalds/Hamano, 2005).
- Why: content addressing makes dedup, provenance, versioning, and partial
  recompilation structural rather than bolted on.

### Hebbian association — `salience.coactivate`, `lattice.ts`
- Hebb, *The Organization of Behavior* (1949): "cells that fire together wire
  together."
- Why: the value lattice's affinity/tension edges self-organize from
  co-activation counts; no model decides what relates.

### Predictive-coding / free-energy updates — `salience.applyPredictionError`
- Rao & Ballard (1999); Friston, free-energy principle (2010).
- Why: the soul is a predictive model of its own behavior; a correction is a
  large prediction error and updates salience proportionally.

### Complementary Learning Systems / systems consolidation — `consolidate.ts`
- McClelland, McNaughton & O'Reilly (1995); memory replay during sleep
  (Wilson & McNaughton, 1994).
- Why: fast intake (crystallize) vs. slow reorganization (the "dream" pass that
  merges drifted-together values and migrates learned state) mirrors the
  fast-hippocampal / slow-neocortical split.

### Feature hashing embedder — `talon-embedder.ts`
- Weinberger et al., "Feature Hashing for Large Scale Multitask Learning" (2009);
  signed hashing to debias collisions.
- Why: a deterministic, dependency-free, model-free encoder we own — robust to
  typos via shared character n-grams; a real sentence encoder drops in behind the
  same interface.

### Generative-Agents retrieval — `retrieve.ts`
- Park et al., "Generative Agents: Interactive Simulacra of Human Behavior" (2023).
- Score = normalized(recency) + normalized(importance) + normalized(relevance),
  each min-max'd to [0,1] before summation, exactly as in the paper. Makes the
  projected soul *relevant to the current moment*, not just globally salient.

### FSRS / DSR adaptive forgetting — `forgetting.ts`
- Wozniak's DSR model; FSRS (open-spaced-repetition); power-law forgetting
  (Wickelgren, 1974) which fits human retention better than an exponential.
- Retrievability R(t) = (1 + FACTOR·t/S)^DECAY with R(S) ≈ 0.9; stability S grows
  on spaced successful recall and shrinks on a lapse. Core traits become durable,
  fads evaporate — emergently.

### Modern Hopfield associative recall — `associative.ts`
- Ramsauer et al., "Hopfield Networks is All You Need" (2020); Krotov & Hopfield
  (2016, 2020). Continuous Hopfield retrieval is one softmax step — the same
  operation as attention.
- Recall from a cue = softmax over Hebbian edge weights, p ∝ exp(β·w); `prime`
  applies the update to the lattice so the soul recalls in constellations.

## Future directions (researched, not yet built)

- **Reflection** (Park et al. 2023): periodically synthesize higher-level
  insights from clusters of evidence. This is the one place a *single, gated*
  model pass could help (naming/insight) — kept off the continuous loop by design.
- **Concept-drift detection** (Bifet & Gavaldà, ADWIN, 2007): detect when
  behavior distribution shifts to open a new developmental epoch in the Spine.
- **Vector-symbolic / hyperdimensional computing** (Kanerva, 2009): bind
  context⊗value into composite hypervectors for compositional, model-free recall.
- **Personalized PageRank centrality** (Page et al., 1999) over the lattice as a
  richer "importance" signal than degree centrality.
