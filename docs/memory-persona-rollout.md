# Memory & Persona — rollout

Execution plan for `memory-persona-plan.md`. Fifteen PRs in seven stages. Each PR
is independently shippable, lands its own runtime consumer (no repeats of the soul's
mistake), and is reviewable on its own.

**Net line count: roughly +3,400 / −4,700.** The codebase gets _smaller_ while
gaining a memory system that works.

Repo conventions every PR here obeys:

- Storage: `sql/<store>.sql` → `npm run build:sql` → committed
  `statements.generated.ts` (`sql-embed.test.ts` fails on drift) →
  `repositories/<store>-repo.ts` (execution + row↔domain mapping, no SQL) →
  `storage/<store>.ts` (domain API, **zero SQL**). DDL goes in `schema.sql`,
  idempotent, applied on every open.
- `storage/` never imports `core/`, `backend/`, or `frontend/` (dependency-cruiser
  `storage-below-the-engine`). **So: the store lives in `storage/`, the policy —
  ranking, retrieval, projection — lives in `core/memory/`.** That split is already
  anticipated by the existing `core/memory/retrieval.ts` seam.
- Prompt text lives in `prompts/`, never in TS. New prompt assets need
  `npm run build:prompts` (`prompts-embed.test.ts` fails on drift).
- Tools are two files: `core/tools/<area>.ts` (zod schema + `bridge("action")`) and
  `core/engine/gateway-actions/<area>.ts` (the action).
- Every PR ships consumers, or `knip` flags the unused exports. That gate is doing
  real work here — respect it rather than suppressing it.
- Validation is CI, not local (`gh pr checks`): `test`, `typecheck`, `lint`,
  `depcruise`, `ratchets`, `knip`, `format:check`.
- Engine-touching PRs (6, 7, 9, 10) need Discord verified — it breaks quietly.

One flag gates the whole new path: **`TALON_MEMORY_STORE`**, default off until
PR 9 is measured. Removed during Stage 6.

---

## Stage 0 — Measure, and stop the bleeding

No new architecture. Ships this week. Independent of everything below, and worth
doing even if the rest is deferred.

### PR 1 — `fix(prompt): rank memory sections instead of head-slicing` ✅ done

The single highest value-per-line change in the plan.

**Landed.** On the live 23,396-char file the view emits 9,461 chars: every live
section present (`## Active Investigations` with its root-cause analysis,
`## Revisions`, `## Branches to clean up` — all previously below the cut), the
newest CI-watch snapshot kept, the two stale duplicates dropped and named. That
is 21% _smaller_ than the old 12k head-slice, so it also cuts the per-turn
cache-write cost. 14 tests; full suite green.

- **New** `core/prompt/memory-view.ts`: split `memory.md` on `##` headings;
  classify each section into a priority tier; collapse "state families" (headings
  sharing a prefix before `(as of` / `(Run #`) to the newest member only; order by
  tier; then cap.
- Tier order: directives/preferences → people & facts → active investigations and
  open items → newest state snapshot → remainder.
- **Edit** `assemble.ts` §4: `capMemory(memory)` → `renderMemoryView(memory)`.
- Tests: a sanitized fixture of the live file, asserting `## Active Investigations`
  survives the cap and exactly one `Inbox / CI Watch` section is retained. Plus:
  **output is byte-identical when the file is under the cap** — keeps the
  prompt-cache tests honest.
- Not wasted work when PR 5 lands: this parser becomes the importer.

### PR 2 — `fix(prompts): write discipline + state/memory split`

- `prompts/heartbeat.md`: heartbeat **stops writing `memory.md`**. It writes
  `memory/state.md` — fully rewritten each run, one keyed section per domain — plus
  today's daily note. This is where "heartbeat dead since 07-10" belongs.
- `prompts/dream.md`: replace-in-place for status topics; a new dated section for an
  existing topic is forbidden; hard size target for `memory.md` (~10 k chars);
  replace _"do NOT remove entries just because they're old"_ with a decay rule;
  removals append to `memory/archive/YYYY-MM.md` rather than vanishing. New stage:
  daily notes older than 14 days collapse into a monthly summary and the originals
  are deleted.
- `assemble.ts`: inject `state.md` as its own capped section (~2 k).
- `prompts/system/workspace.md` + `persistent-memory.md`: document the split and
  who owns which file.
- `npm run build:prompts`, commit the regenerated embed.

### PR 3 — `feat(metrics): per-turn cache read:write telemetry` ✅ done

Prerequisite for the whole usage conversation — see plan §3.6, which now records
what the 2026-07-30 investigation settled: **the Agent SDK exposes no cache-TTL
knob**, so the 1-hour TTL is an upstream ask and prompt size is the only lever
Talon controls. No behaviour change in this PR.

**Landed** as `backend/shared/cache-telemetry.ts` (25 tests). The accounting line
now carries `xturn=hit|miss|none reqs=N rw=R`, derived from the result message's
per-request `usage.iterations` — `xturn` is the field that tracks cost, since the
turn's first request is the only one that reports whether the previous turn's
prefix survived. Plus mid-session tool-set change warnings that name the delta,
a lookback-window flag, and a sub-minimum check on the one-shot paths.

**Read `xturn` first when the data comes in.** Mostly `miss` → the prefix is
dying between turns and the fix is a smaller prefix (or the upstream TTL ask);
mostly `hit` → caching is working and the cost is elsewhere; any `none` → that
prompt isn't cacheable at all.

- `stream.ts` already captures `cache_read_input_tokens` /
  `cache_creation_input_tokens`, and `sessions` already persists the totals. Surface
  the **per-turn** ratio in the post-turn accounting line and persist to `turn_meta`
  (table exists, currently 0 rows).
- Distinguish **within-turn** from **cross-turn** hits — the measured 8:1 ratio is
  ~11 model requests inside one user turn, which tells you nothing about whether the
  _next_ turn hit. Cross-turn is the number that matters.
- Log a hash of the registered tool-name array per turn; warn when it changes
  _within_ a session.
- Count content blocks per turn and flag turns over 20 — that is the cache
  lookback-window limit, and Talon's tool-heavy turns are the shape that trips it.
- Check the one-shot paths (dream, heartbeat, cron) against the model's cacheable
  minimum — 4096 tokens on Opus 4.6 / Haiku 4.5. Below it nothing caches, silently.

---

## Stage 1 — The store

### PR 4 — `feat(storage): typed memory store with FTS5`

- `sql/schema.sql`: `memory` table; `memory_fts` (external-content FTS5 + the three
  `ai`/`ad`/`au` triggers — copy `history_fts` exactly, it is the established
  pattern); `memory_history`; indexes on `(kind, subject)`, `(key)`, `(salience)`.
- `sql/memory.sql`: named statements.
- `repositories/memory-repo.ts`: statement execution, row↔domain mapping.
- `storage/memory-store.ts`: `assert`, `supersede`, `drop`, `merge`, `pin`,
  `search`, `listByKind`, `replaceStateKey`. Validation. Zero SQL, no core imports.
- `npm run build:sql`; commit both files.
- Tests: CRUD; FTS search; **keyed-state replacement semantics**; supersede writes
  history; drop lands in the graveyard; `TALON_DB_PATH` isolation.
- Fold PR 5 in if `knip` objects to the API landing without consumers.

### PR 5 — `feat(memory): import memory.md, render it back`

- `core/memory/import.ts`: `memory.md` + daily notes → rows, reusing PR 1's parser.
  Idempotent via content hash. Original files preserved.
- `core/memory/render.ts`: rows → `memory.md`, ranked and budgeted. Supersedes PR 1's
  ranker as the production path.
- CLI: `talon memory import` / `talon memory render`.
- `/memory` (telegram + native): top rows, search, `/memory why <id>` for provenance.
- With the flag on, the store is authoritative and `memory.md` is rendered output.
  Hand-edits to the file are folded back as an inbox on next import.

---

## Stage 2 — Write path

### PR 6 — `feat(tools): remember / forget / recall`

- `core/tools/memory.ts` + `core/engine/gateway-actions/memory.ts`.
- `remember(kind, text, subject?, key?)` — on assert, FTS near-dupe check turns a
  near-match into a **supersede candidate** instead of a second row. Mechanically the
  highest-leverage reconciliation in the plan, and it lives in the write path.
- `recall(query)` — explicit pull when the model wants more than was auto-injected.
- `forget(id, reason)` — to the graveyard.
- `prompts/system/memory.md`: the norm only (when to remember, what never to store).
  No protocol prose duplicating tool descriptions.
- **Required test: the memory gateway actions never reach
  `notifyPromptInputsChanged`.** This is the cache invariant from plan §3.6, and it
  is the mistake someone will otherwise make on purpose.
- Verify Discord.

### PR 7 — `refactor(soul): taps into the shared engine seam`

The PR that makes persona learning frontend-agnostic — what the soul never got.

- Move directive/correction classification out of
  `frontend/telegram/handlers/messages.ts` into the engine's inbound path, so every
  frontend feeds it.
- Generalize reaction attribution beyond Telegram to native and discord.
- Taps write `directive` / `correction` rows to the store. The soul kernel call
  stays behind its own flag until Stage 6.
- Verify Discord.

---

## Stage 3 — Read path

### PR 8 — `feat(memory): real retriever behind the Phase B seam`

**The PR where memory starts working.**

- `core/memory/store-retriever.ts` implements the existing `MemoryRetriever`: FTS
  match on the inbound message + recency decay + salience + `hit_count`. Sub-
  millisecond, no model call, no MCP round trip.
- Wire in bootstrap: flag on → store retriever; off → `noopMemoryRetriever`.
  `filterAutoInjectable` stays exactly as written; trust policy unchanged.
- Retrieved rows bump `hit_count` / `last_seen_at` — the ranking feedback loop.
- Tests: relevance; trust filtering; **fail-closed on any db error**; budget cap;
  prompt byte-identical when nothing is retrieved.

### PR 9 — `feat(prompt): core view replaces the head-slice`

- `assemble.ts` §4 renders the store's core view: pinned directives + top facts for
  the chat's subject + fresh `state`. Budgeted ~2 k tokens.
- Assert the core view is only ever computed inside the session-frozen build.
- Record the prompt-size delta before/after, against PR 3's baseline.
- Flag flips to default-on here, once the numbers are in.
- Verify Discord.

---

## Stage 4 — Reconciliation

### PR 10 — `feat(memory): op-based reconciliation`

- `core/memory/ops.ts`: op types, validator, transactional applier. Every op writes
  a `memory_history` row.
- Guards: unknown id rejected; dropping a pinned row needs an explicit reason;
  budget enforced; ops per run capped.
- `prompts/dream.md` rewritten: the dream **emits ops** and never rewrites files. It
  receives a _worklist_ — FTS near-dupe candidates, stale state keys, the
  over-budget tail — instead of 23 KB of prose to re-author.
- Tests: every op; each rejection case; rollback on partial failure.
- Verify Discord.

### PR 11 — `feat(memory): diff / undo / audit`

The trust layer. You will only let it forget things once you can see and revert what
it forgot.

- `/memory diff` (last reconcile), `/memory undo <op_id>`, `/memory graveyard`.
- Each dream run reports what it changed.

---

## Stage 5 — Persona

### PR 12 — `feat(prompts): identity.md as voice + stances`

Prompt-only; independent of every other PR; could ship at any point.

- Replace the adjective list with concrete stances on concrete situations — bad
  plan, don't know, someone's upset, third time the same question — each with
  **anti-examples**.
- Strip voice out of `telegram.md` / `discord.md` / `teams.md` / `native.md` /
  `terminal.md`; they keep capability docs only.
- `identity.md` stays **seeded and user-editable** — a shipped rewrite updates the
  package default; a local edit wins and is never clobbered. (Settled: Dylan does not
  need the live NPUW-Agent copy preserved.)

### PR 13 — `feat(persona): relationship block`

- The lens as a query: `relationship` / `directive` / `preference` rows for the
  current subject, ranked, quoted verbatim. ~60 lines replacing `soul/lens.ts`.
- Rendered inside the session-frozen core view.
- Group chats: subject is whoever is speaking; trust rules keep subjects from
  contaminating each other.

### PR 14 — `feat(persona): critic as an output guard`

- `soul/critic.ts` → `core/persona/critic.ts`, logic unchanged; its tests come with
  it.
- Wire post-draft: **log-only first** (flag rate per failure mode), then a single
  targeted retry on the strongest classifier, behind a flag.
- Optional: bounded diary read-back, marked as self-reflection, structurally
  excluded from the fact retriever.

---

## Stage 6 — Teardown

### PR 15 — `refactor(soul): remove the kernel`

Pure deletion, easy review. Everything worth keeping was relocated by PRs 7, 13, 14.

- Delete ~4,300 lines and ~26 test files: `dag` `hash` `delta` `hdc` `associative`
  `centrality` `forgetting` `drift` `valence` `emergent-critic` `governance`
  `cluster` `consolidate` `reflect` `compiler` `kernel` `lattice` `retrieve`
  `embedder` `talon-embedder` `projector` `service` `reflex` `signals` `types`
  `settings` `index`.
- Remove `TALON_SOUL_ENABLED`, the `assemble.ts` soul section, `getSoul().dream()`
  in `background/dream.ts`, and the `/soul` admin command (repoint at `/memory`).
- Remove the `TALON_MEMORY_STORE` flag in the same window.
- `knip` + `depcruise` + `ratchets` confirm nothing dangles.

---

## Stage 7 — Surfaces (optional)

`talon://memory/` mount on the existing VFS namespace; a Companion memory view.
A memory you can see and correct by hand is a memory you will trust.

---

## Sequencing

**Critical path:** 4 → 5 → 8 → 9. That is the spine; everything else hangs off it.

**Ships immediately, in parallel, no dependencies:** ~~PR 1~~, PR 2, ~~PR 3~~, and
PR 12.

**Done:** PR 1 and PR 3. PR 1 was the biggest quality win per line in the plan;
PR 3 buys the week of cache data needed before anyone reasons about usage.
Neither touched architecture, so neither can be invalidated by a later design
change.

**Next:** PR 2 (writer discipline — heartbeat stops writing `memory.md`, dream
gets a size target and permission to forget) and PR 12 (identity.md as voice +
stances), both still dependency-free. Then the spine, 4 → 5 → 8 → 9.

Rough sizing: Stage 0 ≈ 600 lines · Stage 1 ≈ 900 · Stage 2 ≈ 500 · Stage 3 ≈ 400 ·
Stage 4 ≈ 600 · Stage 5 ≈ 400 · Stage 6 ≈ −4,300.

## Decisions

1. ~~`identity.md` reseed policy~~ — **settled.** Stays user-editable; local edits
   win, package default updates. PR 12 unblocked.
2. ~~1-hour cache TTL~~ — **settled by investigation.** The Agent SDK
   (`0.3.212`) exposes no cache-control surface, so this is an upstream ask, not a
   config change. Prompt size is the lever we control. See plan §3.6.
3. **`state.md` — file or kind?** _(open)_ PR 2 makes it a file (cheap, immediate);
   PR 4 could absorb it as a `state` kind instead. Recommend the file first, absorb
   later — it de-risks Stage 0 from Stage 1's schedule.
4. **Default-on timing for `TALON_MEMORY_STORE`** _(open)_ — proposed at PR 9, after
   the prompt-size delta is measured against PR 3's baseline.
