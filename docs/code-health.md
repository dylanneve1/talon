# Code health

A static + dynamic analysis pass over the tree (2026-09-01, v3.31.0), the
findings it produced, and which are fixed.

Read this as a worklist, not a scorecard. The structural companion —
the dependency map and the consolidation order — is
[consolidation-plan.md](consolidation-plan.md). The headline is that the codebase is
in good shape — the problems below are specific and bounded, and the largest
one was a gate that had stopped working rather than anything wrong with the
code it was guarding.

## Baseline

| Measure | Value |
| --- | --- |
| Tracked lines of code | ~189,500 across 1,135 files (~177,400 excluding `package-lock.json`) |
| Daemon TypeScript | 135,771 (70,434 of it tests) |
| Companion Dart | 23,591 (5,144 of it tests) |
| Tests | 4,640 daemon, 244 companion |
| Daemon coverage (CI) | 72.1% statements · 63.7% branches · 75.0% functions · 73.3% lines |
| Coverage thresholds | 65 / 60 / 65 / 65 |
| Companion coverage | 57.4% of lines |
| `TODO` / `FIXME` / `HACK` / `XXX` in shipping source | **0** |
| `@ts-ignore` / `@ts-expect-error` | **0** |
| Explicit `any` | 13 |
| npm vulnerabilities | **0** (39 production dependencies) |
| Files over 1,500 lines (non-test TS/Dart) | 3 of 577; 512 are under 400 |

Tooling used: `tsc`, `oxlint`, `dependency-cruiser`, `knip`, `madge`,
`npm audit`, `cloc`, `vitest --coverage`, `flutter test --coverage`.

## 1. The architecture gate was enforcing nothing — **fixed**

`npm run depcruise` reported:

```
✔ no dependency violations found (3 modules, 2 dependencies cruised)
```

Three modules out of ~590. The repo compiles with **typescript@7**, whose API
dependency-cruiser cannot drive ("Support for typescript@>=7 will follow when
its API is published and stable"), so `.dependency-cruiser.cjs` already selects
**swc** as the parser — but `@swc/core` was never in `devDependencies`. With no
parser, dependency-cruiser doesn't fail; it parses almost nothing and reports a
green tick.

The consequence: every rule in `.dependency-cruiser.cjs` — `core-not-to-frontend`,
`core-not-to-backend`, `no-circular`, `util-is-a-leaf`, and the rest — was
inert, while the "Architecture boundaries" step in the Code Quality workflow
passed on every commit.

**Fixed** by adding `@swc/core` to `devDependencies` and replacing the raw
`depcruise src` invocation with `scripts/check-architecture.mjs`, which asserts
two things instead of one:

1. no `error`-severity violations, and
2. the cruise actually covered the codebase (`MODULE_FLOOR`, currently 450).

The floor is the part that matters. A gate that goes blind must fail loudly,
because "no violations found" on 0.5% of the tree is indistinguishable from a
real pass in a CI log. Verified in both directions: with `@swc/core` removed
the gate exits 1 and names the likely cause; with it present it exits 0 after
cruising 587 modules and 2,325 dependencies.

**The good news underneath:** once the gate ran, it found **0 errors**. Every
ratified boundary holds. The 18 warnings are the in-flight migrations the
config documents by name (`backend-sessions-move-to-thread` 11,
`config-belongs-in-core` 3, `doctor-probes-move-behind-registry` 4), each
already annotated with the migration that ratchets it to `error`.

## 2. Circular dependencies — **not a defect; withdrawn**

`madge` reports six import cycles:

```
1) core/agent-runtime/events.ts > core/types.ts
2) core/doctor.ts > core/plugin/native-runtimes.ts
3) …> plugins/github/provision.ts
4) …> plugins/mempalace/provision.ts
5) …> plugins/playwright/provision.ts
6) core/plugin/index.ts > core/plugin/builtins.ts > core/mcp-hub/index.ts
```

All six are false positives, and they are worth writing down so the next person
running `madge` doesn't "fix" them:

- **(1)** is closed by two *type-only* edges — `import type { ReasoningEffortLevel }`
  one way, an inline `import("./agent-runtime/events.js").AgentEvent` type
  position the other. Nothing exists at runtime.
- **(2)–(5)** are closed by a **dynamic** `await import("./plugin/native-runtimes.js")`
  in `doctor.ts`, with `import type { DoctorCheck }` coming back. The lazy edge
  is the deliberate cycle-break.
- **(6)** is closed by a **dynamic** `await import("../mcp-hub/index.js")` in
  `builtins.ts`.

dependency-cruiser's `no-circular` rule models exactly this — it exempts cycles
closed only through a dynamic import — and reports **zero** violations now that
it runs. madge models neither type-only imports nor dynamic-import cycle
breaks. Prefer the `no-circular` rule; treat madge as a smoke test only.

## 3. The native bridge is the thinnest-covered security surface — open

`src/frontend/native` sits at **38.7% statements / 35.3% branches**, against
`src/core` at 86.2%.

That is the code doing bearer-token authentication, the failed-auth lockout,
the pre-auth routes (`/health`, `/pair`, `/node/install`, `/node/binary`), and
transfer-token scoping — the parts where a missed branch is a security bug
rather than a cosmetic one. Coverage effort belongs here before anywhere else,
notably ahead of `src/cli` (14.3%), which is composition-root glue that
integration tests already exercise end to end.

Other thin areas, in rough priority order: `frontend/discord/handlers` (5.2%),
`frontend/telegram/commands` (27.2%), `frontend/telegram/callbacks` (29.5%),
`frontend/whatsapp/actions` (26.3%).

## 4. 255 unused exports, ungated — open

`knip` reports 130 unused exports and 125 unused exported types, and **knip is
not part of the Code Quality gate** (which runs `tsc`, `lint`, `depcruise`,
`ratchets`, `format:check`), so the number only grows.

Most are barrel files re-exporting types nothing imports — `core/mesh/index.ts`
alone accounts for seven (`MeshServiceOptions`, `MeshToolResult`,
`DeviceCommand`, `DeviceCommandResult`, `DeviceInfo`, `DeviceLocation`,
`DevicePlatform`). Also flagged: 8 binaries used by CI scripts but undeclared
(`where.exe`, `gofmt`).

Suggested shape: prune the obvious dead exports, then add knip to CI at a
ratcheted baseline in the style of `scripts/check-ratchets.mjs`, so the residue
can only shrink.

## 5. `settings_screen.dart` is a god file — open

3,434 lines, twice the next-largest file in the repo, at 49% line coverage. It
is the one place where the size discipline that holds everywhere else (512 of
577 files under 400 lines) has broken down, and it is measurably where changes
cost the most.

Natural seams: the per-card builders (`_meshCard`, `_voiceCard`,
`_appearanceCard`, `_diagnosticsCard`, `_statusCard`, `_aboutCard`) are already
independent and could each become their own widget file, leaving the shell and
the shared row helpers behind.

## 6. Companion coverage gaps — open

57.4% of lines overall. The gap that matters is **`mesh_background.dart` at
9.2%** — the Android foreground-service isolate that owns the mesh connection,
answers exec commands, and has to survive reboots and `MY_PACKAGE_REPLACED`.
It is the least-tested code in the app and among the most load-bearing.

Six UI files sit near zero and matter much less: `logs_screen` (0%),
`model_sheet` (0%), `context_sheet` (0%), `extensions_screen` (0.7%),
`quick_switcher` (0.9%), `activity_card` (1.6%).

## 7. Known-deferred, tracked elsewhere

Recorded here only so a future pass doesn't re-report them as new:

- **`noUncheckedIndexedAccess` (666 errors) and `exactOptionalPropertyTypes`
  (303)** are measured and deliberately off, with the counts written into
  `tsconfig.json`. Each is its own fix wave.
- **`naked-throw-in-core` sits at its baseline of 38** (`scripts/check-ratchets.mjs`).
- **Node `engines` requires `>=24.15`** and `.npmrc` sets `engine-strict=true`,
  so `npm ci` refuses on older toolchains by design (it protects the lockfile —
  see the comment in `.npmrc`). On Node 22 three suites fail locally because
  `baileys` and `qrcode` can't install; both are declared dependencies and CI
  is unaffected.
