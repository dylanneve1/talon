# Cache economics — sharing the prefix across chats, and compacting cold sessions

Status: plan, 2026-09-18. Dylan's brief: "keep caching front of mind in
everything; never invalidate cache", "reuse the cached system prompt and
tools from an existing chat when a new session starts", "when caching runs
out, auto-compact so the next message costs less". This document turns
those into three PRs, measurement first.

## What the API actually does

- Prompt caching is a **prefix match**, scoped to the organization and
  model. Render order is `tools → system → messages`; a byte change
  anywhere invalidates everything after it.
- There is no "reuse chat A's cache in chat B" call. Two requests with a
  byte-identical `tools + system` prefix share the cache automatically,
  whichever session sends them, for as long as the TTL lasts. So
  "smarter caching across sessions" means exactly one thing: **make the
  prefix identical across chats and prove it is.**
- The Claude Agent SDK owns `cache_control` placement and the TTL
  (`cache_ttl: '5m' | '1h'` in its hook inputs; Talon's sparse chats want
  `1h`). Talon's levers are prefix bytes, prefix size, and what it sends
  after the boundary. `backend/shared/cache-telemetry.ts` (#PR 3 of the
  memory rollout) already computes the per-turn verdict; it is not yet
  rolled up anywhere an operator can read.
- After the TTL lapses, the next turn re-writes the whole prefix **and
  the whole transcript** at write cost. A long, idle chat is the
  expensive case: the resume costs the full conversation, and every later
  turn re-reads it (cheaply, but it is still there).
- The SDK can compact a session (`SDKCompactBoundaryMessage`, `trigger:
  'manual' | 'auto'`, `pre_tokens`/`post_tokens`; `PreCompact`/`PostCompact`
  hooks; `isAutoCompactEnabled`). Auto-compaction triggers on context
  size, not on cache temperature — the wrong signal for cost.

## PR A — measure (no behaviour change)

1. Roll the existing per-turn verdict up: counters
   `cache.first_request.{hit,miss,none}` and histograms
   `cache.first_request.read_tokens` / `write_tokens` (the turn's FIRST
   request is the only one that says whether the previous prefix
   survived). Record the same for the first turn of a fresh session under
   `cache.session_start.*` — that is the cross-chat sharing signal: a hit
   on a brand-new session means another chat warmed the prefix.
2. Tool-set fingerprint per chat (already computed by
   `noteToolFingerprint`) surfaced as a metric label / log line at session
   start, so two chats on the same frontend can be compared: identical
   fingerprint + identical `staticText` ⇒ shared cache.
3. Parse `SDKCompactBoundaryMessage` in `claude-sdk/stream.ts`: counter
   `session.compacted.{manual,auto}`, histogram `session.compact.pre_tokens`
   / `post_tokens`. Today it is dropped on the floor.
4. Per-chat `lastTurnEndedAt` in the session record (or the Thread), so
   cache temperature can be inferred locally: warm iff
   `now − lastTurnEndedAt < ttl`.
5. Surface: `/status` (all frontends via `collectSessionStatus`) shows the
   chat's last-turn cache verdict and age; `talon metrics` shows the
   rollups. No prompt bytes change.

## PR B — one prefix per frontend

Audit `assembleSystemPrompt` for anything in `staticText` that differs
between two chats on the same frontend (plugin prompt additions, per-chat
MCP servers → tool array, anything keyed by chat). Rule: **`staticText`
and the tool array are a function of (frontend, config) only.** Anything
per-chat moves after the boundary (`dynamicText`) or into the user turn.
Tests: two chats on one frontend assemble byte-identical `staticText`;
`composeTools` output order is deterministic (sorted, not insertion order);
the MCP server list for a chat is ordered. This is what makes PR A's
`cache.session_start.hit` non-zero.

## PR C — compact when the cache has gone cold

Policy, evaluated in the Weaver before a turn runs, off by default until
PR A's numbers say the threshold:

```
cold      = now − lastTurnEndedAt > cacheTtl            (default 1h)
big       = session.usage.contextTokens > minContext    (default 40k)
if cold && big: compact the session first, then run the turn
```

Mechanism, in order of preference:
1. SDK compaction on the resumed session (a `/compact` prompt through
   `query()` with `resume`, or the SDK's manual compaction surface — verify
   which the installed version supports; look for `SDKCompactBoundaryMessage`
   with `trigger: 'manual'` in the reply). One model pass over the cold
   transcript — the same tokens the resume would have re-written anyway —
   and every later turn runs on the compacted context.
2. Fallback when the SDK can't: summarize via the backend's one-shot seam
   (`runOneShotAgent`) into ≤ 2 k chars, `performSessionReset`, and seed
   the summary into the **first user turn** of the new session (never the
   system prompt — the invariant in `docs/memory-persona-plan.md` §3.6).

Config (`cache` block): `idleCompactAfterMs`, `idleCompactMinContextTokens`,
`idleCompact: boolean` (default false until measured). Metrics:
`session.idle_compact` counter, `session.idle_compact.saved_tokens`
(pre − post). The heartbeat's "cold big chat" list can show up in
`/status` before the policy is on, so the numbers are visible first.

## Non-goals

No client-side `cache_control` (the SDK owns it). No second TTL. No
per-chat system prompts to "personalize" caching — that is the opposite
of sharing. Nothing here changes a prompt byte on the default path.
