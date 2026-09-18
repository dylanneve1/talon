/**
 * Architecture boundaries, machine-checked.
 *
 * The layer diagram these rules encode (see also src/core/types.ts):
 *
 *   util, native            — leaves; import nothing above themselves
 *   storage                 — persistence; no core/backend/frontend imports
 *   core                    — the engine; no frontend/backend imports (types.ts:5)
 *   backend                 — agent-runtime adapters; no frontend imports
 *   frontend                — platform drivers; no direct backend imports
 *   cli, app, bootstrap     — composition roots; may import anything
 *
 * Severity discipline:
 *   error — the rule holds today; a violation is a regression and fails CI.
 *   warn  — the rule is the target state of an in-flight migration; each
 *           carries the migration that ratchets it to error. Never add new
 *           violations to a warn rule.
 */
module.exports = {
  forbidden: [
    // ── Ratified boundaries (error = CI gate) ────────────────────────────
    {
      name: "core-not-to-frontend",
      comment:
        "core/ imports nothing from frontend/ (src/core/types.ts:5). " +
        "Frontends register handlers with the engine at startup; the engine " +
        "never reaches into a platform.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/frontend/" },
    },
    {
      name: "core-not-to-backend",
      comment:
        "core/ imports nothing from backend/ (src/core/types.ts:5). " +
        "Backends are bound through the agent-runtime seam, not imported. " +
        "core/doctor/ used to be carved out here; it no longer imports " +
        "backend/ and is covered like the rest of core.",
      severity: "error",
      from: { path: "^src/core/" },
      to: { path: "^src/backend/" },
    },
    {
      name: "backend-not-to-frontend",
      comment:
        "Backends speak to frontends only through the gateway action " +
        "protocol — never by import.",
      severity: "error",
      from: { path: "^src/backend/" },
      to: { path: "^src/frontend/" },
    },
    {
      name: "util-is-a-leaf",
      comment:
        "util/ is the bottom of the stack — anything it imported from the " +
        "layers above would be a cycle waiting to happen. util/ is the " +
        "kernel's lib/: leaf helpers only, nothing that knows what a chat, " +
        "a session or a model is (docs/structure.md, worklist item 4 moved " +
        "the rest to their owning subsystems). What is left has nothing to " +
        "carve out: both exemptions below are now vestigial guards rather " +
        "than live exceptions. The #prompt-assets subpath import is the " +
        "build-time asset seam (package.json `imports` switches " +
        "disk/embedded prompts per runtime) and not a layering edge — its " +
        "last util/ caller left with workspace.ts. metrics.ts left earlier, " +
        "for storage/metrics.ts. Both stay so the seam and " +
        "metrics-read-shape-moves-down keep speaking for their paths if " +
        "anything tries to come back.",
      severity: "error",
      from: {
        path: "^src/util/",
        pathNot: "^src/util/metrics\\.ts$",
      },
      to: {
        path: "^src/(core|backend|frontend|storage|cli|plugins)/",
        dependencyTypesNot: ["aliased-subpath-import"],
      },
    },
    {
      name: "native-is-a-leaf",
      comment: "native/ bricks are self-contained; same rule as util/.",
      severity: "error",
      from: { path: "^src/native/" },
      to: { path: "^src/(core|backend|frontend|storage|cli|plugins)/" },
    },
    {
      name: "storage-below-the-engine",
      comment:
        "storage/ persists; it never calls up into the engine or the " +
        "platform layers.",
      severity: "error",
      from: { path: "^src/storage/" },
      to: { path: "^src/(core|backend|frontend|cli)/" },
    },
    {
      name: "db-handle-stays-in-storage",
      comment:
        "Only stores open the SQLite handle — everything else goes through " +
        "a store's API. Composition roots (app, cli, bootstrap, index) are " +
        "exempt: they own process lifecycle, which includes the final " +
        "flushDatabase.",
      severity: "error",
      from: {
        pathNot: "^src/(storage/|cli/|app\\.ts$|bootstrap\\.ts$|index\\.ts$)",
      },
      to: { path: "^src/storage/db\\.ts$" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Import cycles make ownership ambiguous and break incremental " +
        "reasoning. Cycles closed only through a dynamic import() are " +
        "allowed: the lazy edge is the deliberate cycle-break (module " +
        "load order stays acyclic).",
      from: {},
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ["dynamic-import"] },
      },
    },

    // ── Migration targets (warn = visible, ratchets to error) ────────────
    {
      name: "backend-sessions-move-to-thread",
      comment:
        "DEFERRED BY DESIGN — see docs/weaver.md 'Non-goals': session " +
        "writes still run through the store directly, because backends own " +
        "those callsites and `Thread.session` is a read handle for now. " +
        "Ratchets to error when QueryParams carries a write-capable " +
        "ThreadSession and nothing under backend/ imports the store " +
        "directly. That is ~88 callsites across six backends, so treat the " +
        "current warnings as a visible debt marker, not an imminent " +
        "migration. Do not add new importers. " +
        "(Renamed from sessions-owned-by-weaver: the old name claimed the " +
        "Weaver owns ALL session state, but `from` only covers backend/ " +
        "and core/engine/ — eleven frontend modules import the store too " +
        "and were never flagged. The name now matches what is checked.)",
      severity: "warn",
      from: {
        path: "^src/(backend|core/engine)/",
        // gateway.ts reads getActiveSessionCount() — fleet cardinality for
        // /status, not per-chat session ownership. The Thread migration
        // will not remove it: that count is of persisted rows, while
        // loom.activeContextCount() counts live Threads.
        pathNot: "^src/core/engine/gateway\\.ts$",
      },
      to: { path: "^src/storage/sessions\\.ts$" },
    },
    {
      name: "doctor-probes-move-behind-registry",
      comment:
        "DONE, now enforced: backends contribute their own checks through " +
        "`BackendFactory.doctor` and core/doctor/ composes whatever the " +
        "registry holds — it names no backend and imports none. The rule " +
        "stays as an error so a probe can't creep back into core: a new " +
        "backend gets doctor coverage by implementing the slot, not by " +
        "teaching doctor about itself.",
      severity: "error",
      from: { path: "^src/core/doctor/" },
      to: { path: "^src/backend/" },
    },
    {
      name: "config-belongs-in-core",
      comment:
        "DONE, now enforced: engine configuration lives in core/config/ " +
        "(it imports core/prompt and core/agent-runtime, so it was never a " +
        "leaf utility). A config module under util/ would be a regression.",
      severity: "error",
      from: { path: "^src/util/config" },
      to: {},
    },
    {
      name: "metrics-read-shape-moves-down",
      comment:
        "DONE, now enforced: the metrics read shape was a view over the " +
        "session store misfiled as a leaf utility — it imported nothing " +
        "except storage/sessions and was imported only from backend/ and " +
        "frontend/. It now lives at storage/metrics.ts, beside its data. " +
        "The rule stays as an error so nothing reintroduces a util/ module " +
        "that reaches up into the layers above it.",
      severity: "error",
      from: { path: "^src/util/metrics\\.ts$" },
      to: { path: "^src/(core|backend|frontend|storage|cli|plugins)/" },
    },
    {
      name: "frontend-not-to-backend",
      comment:
        "ENFORCED: frontends consume turn results through the engine, never " +
        "by importing backend/ directly. The last violation was " +
        "`extractSessionName`, a 41-line import-free string helper that was " +
        "simply misfiled under backend/runtime; it now lives in " +
        "core/weaver/session-name.ts (still re-exported from the " +
        "backend/runtime barrel, so backends keep one import site). " +
        "With that gone the " +
        "boundary is clean, so this is an error rather than a target.",
      severity: "error",
      from: { path: "^src/frontend/" },
      to: { path: "^src/backend/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)__tests__/|\\.test\\.ts$|\\.d\\.m?ts$" },
    // The repo compiles with typescript@7 (tsgo), whose API dependency-cruiser
    // cannot drive yet — swc is the parser here, used for import extraction only.
    parser: "swc",
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".mts", ".js", ".mjs"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
