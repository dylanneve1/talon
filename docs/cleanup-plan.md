# Cleanup plan — structure, naming, mega-functions, latency

A map of the tree as of 2026-09-14 (v3.33.4) and the ordered worklist
that falls out of it. Successor to [consolidation-plan.md](consolidation-plan.md)
(whose items 1–6 have landed: #820, #825, #826, #824, #830). Numbers come
from a function-level AST pass (`scripts/check-function-size.mjs`, added
by item A below), `git ls-files | wc`, and reading the code.

The personality stays. Weaver / Loom / Thread / Shuttle / Warp, Warden,
Soul, Dream, Heartbeat, Pulse, Doctor are the vocabulary of the system
and are not renamed. What gets cleaned is the layer underneath them —
the closures, the dumping-ground files, and the three ways of naming a
store.

## Map

### Function size (non-test TypeScript, 2,764 functions)

| Measure | Count |
| --- | ---: |
| Functions over 100 lines | 83 |
| Functions over 150 lines | 40 |
| Functions over 200 lines | 24 |
| Cyclomatic complexity over 20 | 77 |
| Cyclomatic complexity over 30 | 30 |

The 24 over 200 lines fall into five shapes, and each shape has one fix:

| Shape | Functions | Lines / cx | Fix |
| --- | --- | ---: | --- |
| **Frontend factory closure** — one `createXFrontend()` holding all state and every handler as inner functions | `native/index.ts createNativeFrontend`, `whatsapp/index.ts createWhatsAppFrontend`, `teams/index.ts createTeamsFrontend` + `.start` + `poll`, `discord/index.ts createDiscordFrontend` + `.init`, `terminal/index.ts createTerminalFrontend` | 1263/155, 596/103, 391/58, 316/43, 185/15 | Lift closure state into one explicit runtime object; one module per concern (chats, turn, context, emit, connect). The factory becomes wiring. |
| **Backend turn loop** — prompt → stream loop → accounting → trailing-prose retry → result events, three copies | `claude-sdk/handler.ts runChatTurn`, `codex/handler/message.ts handleMessage`, `openai-agents/handler/message.ts handleMessage`, `remote-server/chat-turn.ts runRemoteChatTurn` | 508/64, 488/69, 451/53, 278/20 | The post-loop phases are already commented "shared with the other backends" — make them shared: `backend/shared/turn-phases.ts`. Each backend keeps only its stream loop. |
| **Command / interaction switch** | `terminal/commands.ts registerBuiltinCommands`, `discord/callbacks/components.ts handleComponentInteraction`, `telegram/callbacks/model.ts handleModelCallback` (nesting depth 13), `telegram/middleware.ts registerMiddleware` (depth 11), `telegram/admin.ts handleAdminCommand`, `telegram/commands/{settings,admin}.ts` | 508/111, 529/93, 271/42, 222/39, 236/43, 306/36, 219/34 | Dispatch table keyed by command / customId prefix, one handler per file — the shape #824 gave the native bridge. |
| **Wizard** | `cli/setup.ts runSetup` | 499/85 | One step function per frontend / backend section; an `askOrExit()` helper replaces the `as string` casts around every `isCancel` guard. |
| **Validate-then-mutate action** | `gateway-actions/cron.ts .create_cron_job` / `.edit_cron_job` | 170/61, 169/66 | One `parseCronSpec()` in `core/background/` that both call; the actions shrink to lookup + apply. |

### Naming

The verb vocabulary is already consistent (`get`/`is`/`handle`/`build`/
`create`/`resolve`/`register`/`run`/`init` cover 80% of exports; files are
100% kebab-case; 37 classes, all nouns). What drifted:

| Drift | Where | Fix |
| --- | --- | --- |
| Three naming schemes for one concept | `storage/`: `cron-store.ts`, `goal-store.ts`, `script-store.ts`, `skill-store.ts`, `sticker-store.ts`, `trigger-store.ts`, `scheduled-store.ts` next to `sessions.ts`, `history.ts`, `journal.ts`, `kv.ts`, `metrics.ts`, `chat-settings.ts`, `media-index.ts`, `turn-meta.ts`, next to `repositories/*-repo.ts` | One rule: `storage/<noun>.ts` is the store API, `storage/repositories/<noun>-repo.ts` is its SQL. Drop the `-store` suffix. |
| `Opts` vs `Options` | 4 `*Opts` types against 30 `*Options` | `Options`. |
| Dumping-ground files | `frontend/{discord,telegram,whatsapp}/{actions,callbacks,commands}/shared.ts` (7 files), `frontend/discord/helpers.ts`, `gateway-actions/shared.ts` | Name each by what it holds (`reply.ts`, `context.ts`, `permissions.ts`). A file called `shared` is a file nobody owns. |
| Loose files at `core/` root | `doctor.ts` + `doctor-types.ts`, `notify.ts`, `pairing-broker.ts`, `constants.ts`, `errors.ts`, `types.ts` | `core/doctor/{index,types}.ts`; `notify` and `pairing-broker` are both cross-frontend seams the composition root wires, so they live in `core/frontend-runtime/` as `admin-notify.ts` and `pairing-broker.ts` (not `mesh/` — device pairing is a frontend handshake, not a mesh concern). `errors`, `types`, `constants` stay — they are the root's vocabulary. |
| Engine config filed as a leaf util | `util/config.ts` (843 lines, imports `core/`) | Moved to `core/config/index.ts`; `config-belongs-in-core` ratcheted to error. |

### Latency and startup

There is no timing instrumentation in the daemon: no boot-phase log, no
per-turn phase histogram beyond `response_latency_ms`. Everything below
is therefore a hypothesis ranked by what the code shows, and the first
item is the one that turns hypotheses into numbers.

| Where | What the code does | Cost | Fix |
| --- | --- | --- | --- |
| Turn pipeline | `Weaver.executeInner` → `resolveWarp` → `backend.chat.runChatTurn` → `carryTurnEvents` → frontend `onEvent` | Unmeasured | Per-turn phase timeline (queue wait, warp resolve, prompt build, time-to-first-token, stream, delivery) recorded through the existing `recordHistogram` seam and surfaced in `/status`. Every later item is verified against it. |
| Boot | `bootstrap.ts` walks every chat in `getAllChatSettings()` serially: `rebindChat` (with a 1.5 s sleep-and-retry) then `isModelValidForBackend` (may hit the network) | O(chats) sequential awaits before frontends start | Bounded-concurrency pass (`Promise.all` over batches of 8); a `boot` phase timer so the number is visible in the log. |
| Boot | `bin/talon.js` loads `tsx` on Node and transpiles the source every start | **Measured, not worth it:** `talon --version` is 0.23–0.40 s under tsx and 0.25 s under a native type-stripping loader (Node 22.22, `.js`→`.ts` resolve hook, no esbuild). The transpile is not where boot time goes. | Drop. Listed so nobody re-investigates it. |
| Every log line | `pino` at `trace` with in-process `pino-pretty` on the console stream, always | **Measured:** 11 µs/line pretty vs 1 µs/line JSON (20 k lines, in-process). Only matters past ~10 k lines/s. | Drop. |
| Claude SDK turn | `query()` spawns a fresh `claude` subprocess per turn (`warm.ts` already uses streaming-input mode to keep one alive for the warm-up) | One process spawn + CLI boot before the first token, every turn | Once `turn.first_token_ms` per backend is in the panels, measure it. If the spawn dominates, hold one streaming-input `query()` per busy chat and feed turns into it — the SDK supports it; the retry / interrupt paths are the work. |
| Native frontend | `warmContextCache()` at boot touches 40 chats; `refreshContext()` fire-and-forget after every turn recomputes context and (on a cold entry) resolves the active model | One resolve per chat per boot; one recompute per turn | Bounded concurrency; skip recompute when session usage did not change. |
| Claude SDK turn | `waitForMcpServersReady` polls `mcpServerStatus()` every 100 ms for up to 5 s | Nothing on warm turns (returns on first poll) | Leave. Listed so nobody re-investigates it. |

## Worklist, ordered by value over risk

**A. Function-size ratchet** (limits tightened to 150 / 25 in Tooth 2 below) — `scripts/check-function-size.mjs` on
`oxc-parser` (already in `node_modules` via oxlint), a committed baseline
of the functions currently over the limits (200 lines, complexity 30),
and a Code Quality step. Same contract as `check-ratchets.mjs`: counts
may only fall; lowering the baseline is part of the PR that earns it.
Cheap, and every item below clicks it one tooth tighter.

**B. Turn instrumentation + boot timer** — the two measurement seams
from the latency table. No behaviour change. Lands before any
performance work so each later PR can quote numbers.

**C. Backend turn phases** — `backend/shared/turn-phases.ts`:
`accountTurn`, `enforceTrailingProse`, `buildResultEvents`. The three
handlers drop to their stream loops. Highest duplication in the tree;
best-covered by existing tests (`handler-to-events`, `stream-state`,
`delivered-text` suites).

**D. Native frontend split** — the 1,263-line closure. `chats.ts`
(registry + wire projection), `context.ts` (compute / refresh / warm),
`emit.ts` (assistant / photo / user / system), `turn.ts` (`runTurn` +
`startTurn`), `index.ts` (wiring). Nine test files already import this
module; they keep passing unchanged because the exported surface does
not move.

**E. WhatsApp, Teams, Discord, Terminal factories** — same pattern as D,
one PR each. Each has a `connect`/`poll` loop that becomes its own
module.

**F. Command dispatch tables** — terminal builtin commands, Discord
component interactions, Telegram model callback / middleware / admin.
One PR per frontend.

**G. Setup wizard** and **cron spec** — the two remaining shapes. Small
PRs.

**H. Storage naming** — drop `-store`; `Opts` → `Options`; rename the
seven `shared.ts` files and `discord/helpers.ts`. Mechanical, one PR,
after C–G so it does not conflict with them. Landed: storage, `Opts`,
discord, whatsapp and gateway-actions in #929; the two telegram
`shared.ts` files (→ `actions/{send,rich-messages,coerce}.ts`,
`callbacks/query.ts`) once the telegram dispatch-table PR (#935) was in.

**I. `core/` root tidy + `config → core/config`** — the ratcheted
migration. After H. Both landed (#931, and the config move once E/F were
in so it did not collide with their import rewrites).

**J. Performance PRs, each quoting B's numbers** — boot concurrency,
native context cache, console log level, native type stripping. In that
order; each is independent and revertible.

## Tooth 2 (2026-09-18)

Worklist A–I landed; the 200-line / complexity-30 baseline was down to
one function. The ratchet now runs at **150 lines / complexity 25**, with
a fresh baseline of 28 functions. Same contract: the count only falls,
and the PR that shrinks a function lowers or deletes its entry. The 28
fall into the same shapes as before, and the splits should follow the
same fixes:

| Shape | Functions | Fix |
| --- | --- | --- |
| Backend turn loop (still ~190 L each after #867) | `remote-server/chat-turn.ts runRemoteChatTurn` (200), `codex/handler/message.ts handleMessage` (199), `claude-sdk/handler.ts runChatTurn` (195), `openai-agents/handler/message.ts handleMessage` (186), `shared/handler-to-events.ts handlerToEvents` (161) | Extract the stream-event switch and the prompt/session setup from each loop into named phases; the loop keeps only the iteration. |
| Composition-root wiring | `bootstrap.ts initBackendAndDispatcher` (316), `cli/index.ts runCli` (cx 30), `frontend/terminal/index.ts createTerminalFrontend` (186), `plugins/mempalace/index.ts createMempalacePlugin` (cx 28) | One function per wired subsystem; the root becomes a list of calls. |
| Big switch / classifier | `core/errors.ts classify` (cx 29), `frontend/discord/admin.ts handleAdminSubcommand` (cx 28), `frontend/native/routes/chats.ts chatRoutes` (cx 28), `core/engine/gateway.ts .handleAction` (cx 28), `telegram/model-callbacks.ts parseModelCallback` (cx 28), `telegram/middleware.ts mediaHistoryEntry` (cx 26), `gateway-actions/cross-send.ts .send_via` (cx 30), `native/settings.ts applyConfigUpdate` (cx 29), `codex/one-shot.ts appendCodexItem` (cx 29), `openai-agents/handler/events.ts handleToolCalled` (cx 26) | Table or one-predicate-per-branch; the dispatch-table shape the frontends already use. |
| Long straight-line procedures | `core/tools/messaging.ts .execute#2` (191), `telegram/commands/info.ts registerInfoCommands` (188), `util/mcp-launcher.ts runSupervisor` (187), `core/background/dream/index.ts runDreamAgent` (183), `core/doctor/index.ts collectDoctorReport` (179), `plugins/mempalace/provision.ts reconcile` (156), `native/warden.ts spawnWarden` (cx 28), `frontend/shared/session-status.ts collectSessionStatus` (cx 26), `gateway-actions/fetch-url.ts .fetch_url` (cx 26) | Split at the phase comments they already carry. |

## Out of scope

Soul kernel — torn down in #953, so no longer anyone's cleanup. The
Companion app (`settings_screen.dart` split is tracked in
consolidation-plan.md §8). Test suite restructuring — `src/__tests__/`
is flat and large but it is not what is slowing anyone down.
