# Per-session metrics (design)

> Status: **PLAN — not yet implemented.** This document is the design of
> record for making Talon's metrics (a) persist across restart, (b) bind to
> the chat session rather than a global in-process store, and (c) reset each
> day via retained daily rollup buckets. Implementation lands in follow-up
> commits on this branch.

## Motivation

Metrics today (`src/util/metrics.ts`) are a **global, in-process, low-cardinality**
store — module-level `Map`s of counters and histograms. Two consequences:

1. **They vanish on restart.** Nothing serializes them; a process bounce
   zeroes `/metrics`.
2. **They are fleet-wide, not per-chat.** Chat ids are deliberately never
   interpolated into metric keys (the store caps at 500 keys). So "how much
   has _this_ chat done" isn't answerable from the metrics store — only the
   separate `SessionUsage` accounting (`src/storage/sessions.ts`) is per-chat,
   and it only tracks tokens/cost/response-time, not tool calls, api-call
   distributions, flow violations, etc.

We want metrics **owned by the chat session**, harvested by the Weaver (the
per-chat hub), persisted in SQLite alongside the rest of session state, and
bucketed by day so "today's numbers" reset at the day boundary while history
is retained.

## Decisions (locked)

- **Full session-harvested model.** Per-session counters persist in the
  session store; `/metrics` becomes an aggregation harvested across all
  sessions; the global `src/util/metrics.ts` store is **removed**.
- **Daily rollup buckets.** Keep cumulative per-session totals AND snapshot
  per-day deltas keyed by `YYYY-MM-DD`. "Today" resets at the day boundary;
  history is retained.
- **Latency is per-session.** Response-latency lives on the session (it
  already partly does via `totalResponseMs`/`lastResponseMs`/
  `fastestResponseMs`). We keep per-session latency aggregates; we do **not**
  keep a global latency histogram. Fleet latency is derived by aggregating
  per-session latency aggregates (count/sum/min/max → avg/min/max), not true
  fleet percentiles. This is the accepted trade of dropping the global store.

## Architecture

The Weaver/Loom/Thread subsystem (`src/core/weaver/`, `docs/weaver.md`) is the
single owner of per-chat live state and the intended multi-frontend hub. Per-
session metrics belong here. The collection seam is the Weaver turn runner,
which was recently decomposed into single-purpose collaborators (PR #477).

### 1. Data model — `SessionMetrics`

A new per-session metrics block, persisted next to `SessionUsage`. Two grains:

- **Lifetime cumulative** — monotonic counters/aggregates over the session's
  whole life (survives restart, never reset).
- **Daily buckets** — `Record<string /* YYYY-MM-DD */, DailyMetrics>` capturing
  per-day deltas. A bounded ring (e.g. keep last N days, default 30) so the
  blob can't grow without limit. "Today's" figures are `buckets[today]`.

```ts
type CounterSet = {
  queries: number; // turns
  turnsWithTools: number;
  toolCalls: number; // total across turns
  apiCalls: number; // total upstream round-trips
  turnsFailed: number;
  flowViolationsRetried: number;
  flowViolationsCapExhausted: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type LatencyAgg = {
  count: number;
  sumMs: number; // → avg = sumMs / count
  minMs: number; // fastest
  maxMs: number; // slowest
};

type DailyMetrics = CounterSet & { latency: LatencyAgg };

type SessionMetrics = {
  lifetime: CounterSet & { latency: LatencyAgg };
  buckets: Record<string, DailyMetrics>; // keyed YYYY-MM-DD, bounded
};
```

> Note on histograms vs aggregates: the old store kept a 1000-sample ring per
> histogram to compute p50/p95/p99. Per-session-per-day we keep **count/sum/
> min/max** instead of a sample ring — cheaper to persist, aggregates cleanly
> across sessions, and enough for avg/fastest/slowest. True percentiles are
> the one thing we give up; documented and accepted above. Tool-call-per-turn
> and api-call-per-turn distributions collapse to totals + `queries` (so
> "avg tool calls/turn" is still derivable).

### 2. Persistence

Follow the existing sessions layering (schema.sql → sql/_.sql →
repositories/_-repo.ts → store). Two options, pick at implementation:

- **(preferred) A `metrics TEXT` column on the `sessions` row** — one JSON blob
  per chat, same write-through-cache + per-write-commit discipline as
  `SessionUsage`. Simplest; metrics live and die with the session row
  (`resetSession` already drops the row). Requires: add column to
  `schema.sql`, extend `sessions.sql` upsert/select, regenerate
  `statements.generated.ts` via `npm run build:sql`, map in
  `sessions-repo.ts`, backfill/normalise in `normaliseSession()`.
- **(alt) A dedicated `session_metrics` table** keyed by `(chat_id, day)` —
  first-class daily rows, better for querying/retention, more plumbing. Choose
  this if we later want SQL-level day-range queries or per-day retention
  policies independent of the session row.

Start with the blob column (matches `SessionUsage`'s home and the "bind to the
session" intent); migrate to a table only if query needs demand it.

### 3. Collection — a Weaver collaborator + injected hook

> **As built:** collection landed via §6's option (b) instead — the existing
> `backend/shared/metrics.ts` entry points (`recordTurnMetrics`,
> `recordToolCall`, `recordFlowViolation`, `recordFailedTurnAccounting`) became
> thin shims over the session store, each threading `chatId`. Every backend
> already calls them on both success and failure paths, so no new Weaver
> collaborator, `WeaverDeps` hook, or bootstrap wiring was needed. The
> collaborator route below is retained as the design alternative if collection
> ever needs to move out of the backends.

Mirror the existing `onTurnStart` idiom (`WeaverDeps`), keeping the Weaver
ignorant of the persistence subsystem (DIP):

- Add `onTurnComplete?(summary: TurnMetricSummary): void` to `WeaverDeps`
  (`src/core/weaver/weaver.ts`). Fire-and-forget, must not throw/block.
- The Weaver invokes it in **both** the success path (after
  `carryTurnEvents` returns, where `agentResult`/`durationMs` are in hand,
  `weaver.ts:200-209`) and the failure/finally path — so failed turns are
  accounted (parity with `recordFailedTurnAccounting`).
- A new single-purpose collaborator (`src/core/weaver/turn-metrics.ts`)
  builds the `TurnMetricSummary` from the observed turn. The richer per-turn
  signal (tool-call count, api-call count, flow violations) currently only
  exists in the backend's `StreamState`, not on `AgentResult`. Two sub-steps:
  1. Surface tool/api counts on the `completed` event / `AgentResult` (or
     tee the `AgentEvent` stream in the shuttle to count `tool_call`/`usage`
     events) so the Weaver can see them without reaching into backends.
  2. The collaborator maps that into `TurnMetricSummary`.
- The composition root (`src/bootstrap.ts`, where `initDispatcher`/`WeaverDeps`
  is wired, ~line 363) wires `onTurnComplete` to a session-metrics writer.

```ts
type TurnMetricSummary = {
  chatId: string;
  backend: string;
  durationMs: number;
  toolCalls: number;
  apiCalls: number;
  failed: boolean;
  usage: TokenUsageSnapshot;
  flowViolations?: { retried: number; capExhausted: number };
};
```

### 4. Writer — session store API

New API on `src/storage/sessions.ts` (domain logic only, no SQL):

```ts
export function recordSessionMetrics(
  chatId: string,
  turn: TurnMetricSummary,
  today: string,
): void;
```

- Fold the turn into `lifetime` and into `buckets[today]` (create the day
  bucket if absent; evict oldest when over the retention cap).
- `today` is passed in (date is computed by the caller/bootstrap, not inside
  the store — keeps the store deterministic/testable and avoids `Date.now()`
  scattering).
- Persist the whole session row (existing `persist()`), same failure-swallow
  discipline (never breaks a turn).

The daily reset is **emergent**, not a scheduled job: each turn writes into the
current day's bucket, so a new day naturally starts a fresh bucket. No cron
needed. `/metrics` reads `buckets[today]` for "today", `lifetime` for all-time.

### 5. Read side — `/metrics` and `/status`

- `/metrics` (`src/frontend/{telegram,discord}/commands/admin.ts`) currently
  calls `getMetrics()` from the global store. Replace with an aggregator that
  harvests across sessions: iterate `getAllSessions()` (or a new
  `getFleetMetrics(day)` in the store), summing `CounterSet`s and merging
  `LatencyAgg`s (sum counts/sums, min of mins, max of maxes). Renders both
  "today" and "lifetime" columns.
- Optionally enrich `ThreadSnapshot`/`SessionSummary` (`src/core/weaver/
thread*.ts`) with a per-session metrics summary so a single chat's numbers
  show in `/status` — this is the "harvest from the loom" read seam.
- The renderers (`diagnostics.ts`, discord `helpers.ts`) adapt to the new
  shape (avg/min/max instead of p50/p95/p99).

### 6. Removal of the global store

- Delete `src/util/metrics.ts` (or reduce to nothing) and its callers:
  - `src/backend/shared/metrics.ts` stops calling `incrementCounter`/
    `recordHistogram`. `recordTurnMetrics`/`recordToolCall`/
    `recordFlowViolation`/`recordFailedTurnAccounting` either (a) move their
    signal onto the per-turn summary the Weaver collects, or (b) become
    thin shims the Weaver's collaborator consumes. Net: the per-turn metric
    vocabulary is preserved, but its sink is the session store, not a global
    Map.
  - Update tests: `src/__tests__/metrics.test.ts`, `backend-metrics-usage.test.ts`,
    `live-turn-overlay.test.ts`, `codex-handler.test.ts` (they import
    `resetMetrics`/`getMetrics`).
- Keep the per-backend dimension **as a fleet aggregation** if still wanted:
  since chat→backend can vary per turn, per-backend fleet numbers are best
  kept as a small global counter OR derived by tagging each turn's backend in
  the summary and bucketing per-backend inside the fleet aggregator. TBD at
  implementation; the per-session model is the priority.

## Migration / compatibility

- `normaliseSession()` backfills an empty `SessionMetrics` for pre-existing
  session rows (same pattern as the `SessionUsage` field backfills); persisted
  blobs are validated/normalised once at hydration (`sessions-repo`).
- **Reset vs delete:** conversation resets (`resetSession` — /new, model
  switches, error recovery) carry the chat's metrics forward into the fresh
  row; only `deleteSession` (chat deletion) drops them. Without this, an
  error-recovery reset would erase the very failure counters that recorded it.
- No data migration needed for the removed global store — it was never
  persisted, so there's nothing to migrate; fleet numbers simply start
  accumulating per-session from deploy.

## Testing

- Unit: `recordSessionMetrics` folds counters, creates/evicts day buckets,
  merges latency aggregates; `normaliseSession` backfills.
- Weaver: `onTurnComplete` fires on success AND failure paths with correct
  summary; does not throw into the turn.
- Fleet aggregator: sums across sessions, min/max merge correctness.
- Discord: validate via CI (`gh pr checks`) per repo convention — no local
  Discord toolchain.

## Open questions — resolved at implementation

1. Blob column vs dedicated table (see §2) — **blob column** (`sessions.metrics
TEXT`), reconciled on open for pre-existing databases.
2. Day-bucket retention — **fixed at 30 days**, evicted oldest-first inside
   `metricBucket()`; not configurable until someone needs it.
3. Per-backend fleet dimension — **kept per-session** under
   `MetricsGrain.backend`, aggregated across sessions by `getMetrics()` /
   `getTodayMetrics()` at read time.
4. Day boundary timezone — **UTC** (`todayUtc()`), for determinism; `/metrics`
   labels the today section "today (UTC)".
