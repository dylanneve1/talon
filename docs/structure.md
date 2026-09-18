# Structure — the tree contract

Status: plan of record, 2026-09-18. Dylan's brief: the codebase is getting
bigger, with many components and folders; "branch and tree it as much as
possible to make it manageable — some components will be large, but think
of how the Linux kernel is structured."

The kernel is navigable at 30 M lines because every directory is one
subsystem with one owner and one public surface, drivers of a kind all
have the same shape, and nothing is named `misc`. Talon is 620 source
files; the same discipline scales it down. This document is the contract,
`scripts/check-tree.mjs` is the gate, and the worklist below is the order.

## The map, kernel-style

| Talon | Kernel analogue | Rule |
| --- | --- | --- |
| `src/core/` | `kernel/`, `mm/`, `fs/` | The engine. Every subdirectory is one subsystem (`weaver/`, `engine/`, `memory/`, `mesh/`, `prompt/`, `background/`, …). |
| `src/backend/<id>/` | `drivers/<class>/<driver>/` | One directory per model provider, all the same shape (`factory.ts`, `handler/`, `models/`). Shared driver code in `backend/shared/` becomes a named library (see below). |
| `src/frontend/<id>/` | `drivers/<class>/<driver>/` | One directory per chat platform, all the same shape (`index.ts` wiring, `runtime.ts`, `actions/`, `commands/`, `callbacks/`, `handlers/`). |
| `src/storage/` | `fs/` | Store API at the top, `repositories/` for SQL, `sql/` for statements. Already in shape. |
| `src/util/` | `lib/` | **Leaf** helpers only — nothing that knows what a chat, a session or a model is. Everything else moves into the subsystem that owns it. |
| `src/native/`, `native/` | `arch/` | The bricks (WASM, Gleam, Zig, Rust) and their loaders. |
| `src/plugins/` | `drivers/` (out-of-tree style) | One directory per plugin. |
| `prompts/`, `docs/` | `Documentation/` | Prompts are data; docs are the maintainer's notes. |

## Rules (enforced by `npm run tree`)

1. **One directory, one concern, one entry.** A subsystem directory has
   an `index.ts` (or a single obvious entry named for the subsystem) that
   is its public surface. Siblings import each other through that entry
   or a clearly public module, never by reaching into another subsystem's
   internals. (Enforcement of the import side is depcruise's job and is
   added per subsystem as each one is tidied — not a big-bang rule.)
2. **At most 12 source files directly in a directory.** More means two
   concerns share a folder. Split by concern into subdirectories, each
   with its own entry. Large *components* are fine (`mesh/` can be 4 k
   lines); large *flat folders* are not.
3. **No dumping-ground names.** `shared`, `helpers`, `util(s)`, `common`,
   `misc` — as a directory or a file — are folders nobody owns. Name the
   thing by what it holds: `access.ts`, `render.ts`, `send.ts`,
   `interaction.ts`, `query.ts`.
4. **Drivers are uniform.** A new frontend or backend is created by
   copying the shape of an existing one, not by inventing a layout. The
   registries (`core/frontend-runtime/builtins.ts`, `backend/builtins.ts`,
   `core/tools/index.ts`, `core/engine/gateway-actions/index.ts`) are the
   only places that list them.
5. **Layering is downward only.** `util` ← `storage` ← `core` ← `backend`
   / `frontend`, never sideways between drivers, never up. (Existing
   depcruise errors.)
6. **Ratchets only tighten.** `check-tree.mjs` has a baseline of today's
   violations; a PR may not add one, and the PR that fixes one deletes
   its entry. Same contract as the function-size and naked-throw gates.

## Current violations (the baseline, 2026-09-18)

| Directory | Files | Fix |
| --- | --- | --- |
| ~~`frontend/native`~~ (done #960) | 30 | `bridge/` (server, tls, auth, routes/), `chats/` (chats, chat-wire, chat-lifecycle, empty-chat-sweep, reset), `turn/` (turn, queue, emit, tool-result, turn-meta, context), `surface/` (settings, models, status, memory, logs, extensions, control, discovery), `media/` |
| `core/tools` | ~~25~~ **done** | ~~one file per domain is right; group into `chat/`, `ops/`, `content/`, `system/` with an `index.ts` per group feeding `ALL_TOOLS`~~ → landed as `chat/` (9), `ops/` (11), `content/` (2) with `index.ts`, `types.ts`, `schemas.ts` at the root. No `system/` group and no per-group `index.ts`: the root `index.ts` **is** the registry and imports each module by path, which keeps knip's entry graph and module load order identical to the flat layout. `ALL_TOOLS` keeps byte-identical element order — it sits in the prompt-cache prefix, so a reorder re-bills every live chat; `compose-tools.test.ts` pins the name list. |
| `util` | 22 | move non-leaf modules to their owners: `mcp-launcher` → `core/mcp-hub/`, `workspace` → `core/vfs/`, `watchdog` + `respawn` + `boot-timer` → `core/daemon/`, `web-content` → `core/tools/content/`, `session-name` → `core/weaver/`, `harden` → `core/config/`, `chat-id` → `core/frontend-runtime/`; delete `cleanup-registry` (no importer). What stays is a leaf: log, paths, time, fs-path, http-body, exec-output, concurrency, binary-on-path, tail-file, runtime, version, trace. |
| `storage` | 21 | fine as a flat store API — but `repositories/` (13) says the same thing; both stay, both are the one exception the baseline documents |
| `backend/shared` | 21 | it is a library, not a dumping ground: rename to `backend/runtime/` and split `turn/` (turn-phases, stream-state, handler-to-events, result-events, delivered-text, delivery, model-retry, handle-retry, turn-interrupt), `prompt/` (system-prompt, prompt-format), `cache/` (cache-telemetry, cache-metrics), `usage.ts`, `metrics.ts`, `frontends.ts` |
| ~~`frontend/whatsapp`~~ (done #958) | 19 | `connection/` (connection, auth-state, wa-logger, pairing, pairing-lock, pairing-service, identity), `messages/` (inbound, message-store, media-store, turn-recovery, pins), `access.ts`, `commands.ts`, `actions/` |
| `cli` | 18 | `commands/` one file per command (already nearly so) + `index.ts` |
| `core/engine/gateway-actions` | 17 | domain files are right; split `native.ts` (1 k lines) by route group and move validation next to its users |
| `backend/remote-server` | 17 | `session/`, `model-catalog/` (exists), `server/` |
| `native` | 15 | one directory per brick loader |
| `frontend/telegram`, `frontend/discord` | 14 | `connection/` for both; `telegram/helpers/` dissolved (item 7): `diagnostics` → `telegram/render/reports.ts`, `menu` → `telegram/render/menu.ts`, `format` → `frontend/presentation/format` |
| `backend/codex`, `backend/claude-sdk` | 14 | `session/`, `stream/`, `options.ts` |
| `core/mesh` | 13 | `devices/`, `links/`, `transfers/`; rename `common.ts` |
| `util`, `backend/shared`, `mesh/common.ts` | names | rename per rule 3. Done: `frontend/shared` → `frontend/presentation/` and `telegram/helpers` → `telegram/render/` (item 7). |

Also on the list, not gate-detected: `core/scripting/` + `core/scripts/`
are one subsystem (`core/scripts/{runner,lua}.ts`); `core/background/`
(11 flat files + `heartbeat/` + `triggers/`) becomes `cron/`, `dream/`,
`pulse/`, `heartbeat/`, `triggers/`; `backend/kilo` + `backend/opencode`
(810 lines of thin wrappers over `remote-server`) become two profile
modules under `remote-server/profiles/`; and the frontend duplication the
name survey found — `tryAction` ×2, `renderUsageMessage`/`renderSettingsText`/
`renderMeshReport`/`meshDeviceLine` ×2 (HTML vs markdown variants of one
report), the access gate wrappers (`isAccessAllowed`, `isDmAllowed`,
`isUserRateLimited`, `setAccessControl`, `notifyUnauthorized`,
`trackDmUser`) ×2, `restoreScheduledMessages` ×2, `flushQueue` ×2 —
collapses into `frontend/presentation/` (reports parameterised by a
formatter) and `core/frontend-runtime/` (the gate). The five reports are
done: `frontend/presentation/reports.ts` writes each once and takes the
markup dialect from a `ReportFormatter`. The access gate is still ×2.

## Worklist, in order

Each item is one PR, byte-identical behaviour, `git mv` where possible so
history follows the file. Tests move with their subjects; exported
surfaces of entry files do not change.

1. **native tree** — `frontend/native` → the five subdirectories above.
2. **whatsapp tree** — `frontend/whatsapp` → `connection/`, `messages/`.
3. **background tree** — `core/background` → `cron/`, `dream/`, `pulse/`;
   fold `core/scripting` into `core/scripts`.
4. **util → owners** — the move list above; `util` ends at 12 leaves.
5. **backend/shared → backend/runtime** with the three subdirectories.
6. ~~**tools groups**~~ (done), **gateway-actions/native split**.
7. **frontend presentation** — dedupe the report renderers and the access
   gate; dissolve `telegram/helpers`; `frontend/shared` → `frontend/presentation`.
   Reports, renames and `telegram/helpers` done; the access gate
   (`frontend/presentation/access.ts` → `core/frontend-runtime/`) remains.
8. **telegram / discord / codex / claude-sdk / remote-server / mesh / cli /
   native (bricks)** trees — one PR each, smallest first.
9. **kilo/opencode → remote-server profiles.**
10. **docs** — finished plans (`agentevent-migration`, `consolidation-plan`,
    `cleanup-plan`, `code-health`) move to `docs/archive/`; `docs/README.md`
    indexes what is live.

Items 1–3 are disjoint and run in parallel; 4 waits for them (it rewrites
imports in their directories); 5–9 follow; 10 is glue.
