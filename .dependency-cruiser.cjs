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
        "doctor.ts is carved out below with its own migration rule.",
      severity: "error",
      from: { path: "^src/core/", pathNot: "^src/core/doctor\\.ts$" },
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
        "layers above would be a cycle waiting to happen. The #prompt-assets " +
        "subpath import is exempt: it is the build-time asset seam " +
        "(package.json `imports` switches disk/embedded prompts per runtime), " +
        "not a layering edge. config.ts and metrics.ts are carved out below " +
        "with their own migration rules.",
      severity: "error",
      from: {
        path: "^src/util/",
        pathNot: "^src/util/(config|metrics)\\.ts$",
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
      name: "sessions-owned-by-weaver",
      comment:
        "TARGET (Weaver step 5): only the Weaver owns session state; " +
        "backends receive a session handle from the Thread's warp instead " +
        "of importing the store. Ratchets to error when " +
        "engine/backend-controller/legacy.ts is deleted. Do not add new " +
        "importers.",
      severity: "warn",
      from: {
        path: "^src/(backend|core/engine)/",
        pathNot: "^src/core/engine/backend-controller/",
      },
      to: { path: "^src/storage/sessions\\.ts$" },
    },
    {
      name: "doctor-probes-move-behind-registry",
      comment:
        "TARGET: doctor.ts checks backend health by importing backend " +
        "modules directly. Ratchets to error when backends export " +
        "DoctorCheck providers and the composition root wires them in. " +
        "Do not add new backend imports here.",
      severity: "warn",
      from: { path: "^src/core/doctor\\.ts$" },
      to: { path: "^src/backend/" },
    },
    {
      name: "config-belongs-in-core",
      comment:
        "TARGET: util/config.ts imports core/prompt and core/agent-runtime " +
        "— it is engine configuration, not a leaf utility, and should move " +
        "to core/config/. Ratchets to error when the move lands. Do not " +
        "add new upward imports.",
      severity: "warn",
      from: { path: "^src/util/config\\.ts$" },
      to: { path: "^src/(core|backend|frontend|storage|cli|plugins)/" },
    },
    {
      name: "metrics-read-shape-moves-down",
      comment:
        "TARGET: util/metrics.ts re-exposes session read shapes from " +
        "storage/. Either the read shape moves into storage/ proper or " +
        "this module moves up beside its data. Ratchets to error with " +
        "that move. Do not add new upward imports.",
      severity: "warn",
      from: { path: "^src/util/metrics\\.ts$" },
      to: { path: "^src/(core|backend|frontend|storage|cli|plugins)/" },
    },
    {
      name: "frontend-not-to-backend",
      comment:
        "TARGET: frontends consume turn results through the engine, not by " +
        "importing backend/shared helpers. Ratchets to error when the " +
        "Shuttle owns turn choreography and backend/shared shrinks to the " +
        "adapter contract. Do not add new importers.",
      severity: "warn",
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
