# Long-term plan: migrating Talon off TypeScript

Status: **proposal** (2026-08). Owner: Dylan. Nothing below is committed
until its phase's entry gate is met.

## Why, and why carefully

Motivation is performance headroom and long-term control over the
runtime. The constraint is that Talon is a live, actively-developed
170k-LOC daemon whose load-bearing dependencies are npm packages, so a
big-bang rewrite is off the table. The shape of this plan is a
**strangler migration**: measure, shrink the JS surface, harden the
process boundaries we already have, then move subsystems one at a time —
with a checkpoint after every phase where "stop here" is a legitimate
outcome.

Two facts keep the plan honest:

1. **Talon is I/O-bound.** Turns are dominated by LLM latency and
   Telegram round-trips; `tsc --noEmit` over the whole tree is ~3s; the
   recent perf defects (blind 600s retries, per-turn MCP respawns) were
   architectural, not linguistic. Every phase therefore has a _measured_
   entry gate — we do not migrate on vibes.
2. **The repo already runs four languages behind stable boundaries.**
   `protocol/` holds one fixture-verified wire definition with three
   independent implementations (TS daemon, Dart companion, Go
   talon-node), and `native/` holds Rust/Zig/Gleam cores. The migration
   machinery — conformance fixtures per boundary, CI per implementation
   — already exists and just gets extended.

## Target architecture

```
┌────────────────────────────────────────────────────────┐
│ core daemon (target language — see decision below)     │
│ dispatcher/weaver · queues · storage · cron · triggers │
│ bridge protocol server · watchdog · frontends          │
└──────┬──────────────┬──────────────┬───────────────────┘
       │ HTTP         │ stdio NDJSON │ stdio MCP
┌──────▼─────┐ ┌──────▼───────┐ ┌────▼─────────┐
│ opencode / │ │ JS sidecars  │ │ MCP children │
│ kilo / etc │ │ (npm-only    │ │ (unchanged)  │
│ (already   │ │  deps live   │ └──────────────┘
│  external) │ │  here)       │
└────────────┘ └──────────────┘
```

The key insight: most of Talon's "npm dependencies" are already spoken
to over language-neutral boundaries (HTTP servers, spawned CLIs, stdio
MCP). The genuinely npm-only surface is small, and it lives behind
**sidecars** — thin supervised JS processes exposing one dependency each
over a versioned NDJSON-over-stdio protocol, exactly like MCP hub
children are supervised today.

## Dependency inventory (35 runtime deps)

| Disposition                                  | Packages                                                                                                                                                                                                                                                                                                                                                                      | Notes                                                                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidecar (npm-only, no native equivalent)** | `@anthropic-ai/claude-agent-sdk`                                                                                                                                                                                                                                                                                                                                              | The agent loop host. Wraps the Claude Code runtime; no non-JS equivalent. Becomes the `talon-agent-host` sidecar speaking `AgentEvent` NDJSON — the internal event union in `core/agent-runtime/events.ts` is already the exact contract. |
| **Sidecar initially, native later**          | `telegram` (GramJS) + `big-integer`                                                                                                                                                                                                                                                                                                                                           | MTProto userbot. Go `gotd` / Rust `grammers` exist but session-format migration is risky — sidecar first, evaluate native port last.                                                                                                      |
| **Already language-neutral**                 | `@opencode-ai/sdk`, `@kilocode/sdk`, `@openai/codex-sdk`, `@playwright/mcp`, `@brave/brave-search-mcp-server`, `mem0ai`                                                                                                                                                                                                                                                       | HTTP servers, spawned CLIs, or stdio MCP servers. The core talks protocols, not packages.                                                                                                                                                 |
| **Native equivalents are mature**            | `grammy` + `@grammyjs/*` (Bot API = plain HTTPS), `discord.js` (discordgo/serenity), `@modelcontextprotocol/sdk` (official Go/Rust SDKs), `@anthropic-ai/sdk`, `openai`, `@openai/agents` (HTTP APIs), `cheerio`, `croner`, `file-type`, `liquidjs`, `marked`, `pino`, `undici`, `yaml`, `zod`, `p-retry`, `write-file-atomic`, `cross-spawn`, `picocolors`, `@clack/prompts` | Standard-library or well-trodden libraries in Go/Rust.                                                                                                                                                                                    |
| **Runtime-only, disappears**                 | `tsx`                                                                                                                                                                                                                                                                                                                                                                         | Replaced in Phase 1.                                                                                                                                                                                                                      |
| **Portable by design**                       | `wasmoon` (Lua-in-wasm), `native/*` wasm cores                                                                                                                                                                                                                                                                                                                                | Any wasmtime host runs the same `.wasm`; blake3 also has a napi build.                                                                                                                                                                    |

Net: **one hard sidecar** (agent host), **one transitional sidecar**
(userbot). Everything else is a port, not an adapter.

## Language decision (open — decide at Phase 3 entry, not before)

|                                                  | Go                                                                       | Rust                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| In-tree precedent                                | ✅ `apps/node` already implements the bridge protocol                    | wasm cores only                                           |
| Ecosystem for Talon's needs                      | gotd, discordgo, official MCP SDK, goldmark, robfig/cron, modernc sqlite | grammers, serenity, rmcp (Codex itself uses it), teloxide |
| Migration velocity for 170k LOC of orchestration | ✅ high                                                                  | lower                                                     |
| Runtime perf / RSS                               | good                                                                     | best                                                      |
| Single-binary + cross-compile                    | ✅ trivial                                                               | ✅                                                        |

Default recommendation is **Go** (velocity + in-tree precedent + the
bridge conformance suite already passing against a Go implementation),
with Rust reserved for perf-critical cores via the existing `native/`
pattern. Revisit with Phase 0 data in hand.

## Phases

### Phase 0 — Measure (entry gate for everything else)

- Add boot-time and per-turn CPU/RSS accounting to the existing metrics
  (`storage/metrics.ts`); one `node --cpu-prof` capture of a real turn.
- Publish the baseline in this doc. Define the targets that would
  justify later phases (e.g. boot < 1s, idle RSS < X MB, p95 turn
  overhead < Y ms — filled in from the baseline).
- **Exit:** numbers in hand. **Kill criterion:** if the TS control plane
  is <5% of turn latency and RSS is acceptable, later phases are
  optional perf work, not a migration.

### Phase 1 — Bun as the runtime (decided 2026-08-22)

Bun 1.3.9 already runs the CLI cleanly and CI has a bun-compile sanity
job. Adoption checklist:

- [ ] Full vitest suite green under Bun
- [ ] `node:sqlite` behavior verified under Bun (storage tests on a real db)
- [ ] napi (blake3-napi) + FUSE natives load, or wasm fallbacks engage
- [ ] pino file transport + pretty stream behave
- [ ] grammY long-poll + GramJS soak (24h shadow instance) — no fd/RSS creep
- [ ] `_mcp-launch` supervisor re-exec works under `process.execPath` = bun
- [ ] Update packaging (nfpm, Docker) to ship bun; keep `npm run start:node`
      as a fallback entrypoint for one release cycle

**Exit:** daemon runs on Bun in production for 2 weeks with boot/RSS
deltas recorded here. This phase alone may deliver most of the felt win.

### Phase 2 — Harden the seams (still 100% JS)

- Define `protocol/agent-host_v1.json` fixtures: the `AgentEvent` stream
  - a small control RPC (runTurn, interrupt, setMcpServers) as
    NDJSON-over-stdio.
- Extract the claude-sdk backend into the `talon-agent-host` sidecar
  process behind that protocol, supervised like an MCP hub child
  (respawn-with-backoff already exists). The daemon side keeps its
  `ChatBackend` interface — this is a process split, not a redesign.
- Do the same for the GramJS userbot (`talon-userbot` sidecar) behind an
  events/commands protocol.
- **Why now:** proves the adapter design end-to-end while everything is
  still one language and trivially debuggable. Also buys crash isolation
  (an SDK OOM no longer takes down the daemon) regardless of what
  happens later.
- **Exit:** production-stable sidecars, conformance fixtures in CI.

### Phase 3 — Core skeleton in the target language

- Decide Go vs Rust (matrix above + Phase 0/1 data).
- Stand up the new core implementing, in order: storage repos (SQLite —
  mechanical, schema already migration-cursored), cron/scheduler, the
  per-chat FIFO dispatcher, watchdog, bridge protocol server (conformance
  fixtures already exist to verify it).
- Runs as a shadow daemon against a copy of `~/.talon` replaying
  journal fixtures; dual-run comparison on the bridge protocol surface.
- **Exit:** shadow daemon passes all `protocol/` fixtures + a replayed
  week of journal traffic with identical outcomes.

### Phase 4 — Frontends and backends flip

- Telegram Bot API + Discord natively in the core (plain HTTPS/gateway);
  userbot stays a sidecar.
- OpenCode/Kilo/Codex backends: the core speaks their HTTP/CLI protocols
  directly (already language-neutral). Claude backend: core supervises
  `talon-agent-host` sidecar via the Phase 2 protocol.
- Cutover per frontend behind config flags; instant rollback = flip the
  flag back to the JS daemon.
- **Exit:** JS daemon no longer serves production traffic.

### Phase 5 — Retire and re-evaluate

- Delete migrated TS subsystems; the JS runtime ships only as the
  sidecar host (bun single-binary per sidecar).
- Annual review of remaining sidecars: agent-host (tracks whether a
  non-JS agent runtime appears), userbot (gotd/grammers maturity).

## Risks

| Risk                                           | Mitigation                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Dual-maintenance window freezes feature work   | Phases 2 and 3 are additive (sidecars, shadow daemon); the flip in Phase 4 is per-subsystem with flags |
| `claude-agent-sdk` churns fast                 | Sidecar isolates the churn behind `AgentEvent` — already Talon's internal contract                     |
| Bun compat gaps (napi, node:sqlite edge cases) | Phase 1 checklist + Node fallback entrypoint for one release                                           |
| Session/state format drift (GramJS ↔ gotd)     | Userbot ports last, behind its own sidecar protocol                                                    |
| The rewrite is slower than the original        | Phase 0 baseline + per-phase exit measurements; kill criteria are part of the plan                     |
