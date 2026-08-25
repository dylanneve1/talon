/**
 * MemPalace provisioner — self-installing, self-healing Python runtime.
 *
 * Talon owns exactly one environment: the venv at ~/.talon/mempalace-venv
 * (the default `pythonPath`). That env is created on first boot, kept on
 * the pinned mempalace version, healed when broken, and carried through
 * one-time palace migrations. Any other `pythonPath` — a uv tool, pipx,
 * conda, or hand-rolled venv — is respected as operator-managed: probed
 * and advised on (exact upgrade command for its flavor), never mutated.
 *
 * Ordering guarantees, in priority order:
 *   1. A working install keeps working. Upgrade failures (network down,
 *      PyPI outage) leave the current version serving and retry later
 *      with backoff.
 *   2. Version drift reconciles in the background — boot never blocks on
 *      pip when a usable install exists.
 *   3. Destructive healing (venv --clear) only ever targets the
 *      Talon-owned venv, and only when it is already unusable.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DoctorCheck } from "../../core/doctor.js";
import {
  compareVersions,
  expandHome,
  failDetail,
  findBasePython,
  loadProvisionState,
  markProvisionFailure,
  markProvisionSuccess,
  provisionBackoffMs,
  runStep,
  saveProvisionState,
  shouldAttempt,
  type ExecFn,
  type ProvisionOutcome,
  type ProvisionState,
} from "../../core/plugin/provision.js";
import { dirs, files } from "../../util/paths.js";

/**
 * The mempalace version Talon installs and reconciles the managed venv
 * to. Bump deliberately, with the canary workflow green — see
 * .github/workflows/native-provision.yml.
 */
export const MEMPALACE_PINNED_VERSION = "3.8.0";

/** Minimum python for the managed venv (matches mempalace's supported floor). */
const PYTHON_MIN = { major: 3, minor: 10 };

/** One-time palace migration ledger key (mempalace >= 3.4 wing renames). */
const WING_MIGRATION = "wing-names";

/**
 * One subprocess proves both facts that matter: the dist is installed
 * (metadata resolves) and the MCP server module actually imports.
 */
const HEALTH_SNIPPET =
  "import importlib.metadata as m; v = m.version('mempalace'); import mempalace.mcp_server; print(v)";

const PROBE_TIMEOUT_MS = 30_000;
const VENV_TIMEOUT_MS = 120_000;
const PIP_TIMEOUT_MS = 900_000;
const MIGRATE_TIMEOUT_MS = 600_000;

/** The `mempalace`/`memory.mempalace` config section this module reads. */
export interface MempalaceSection {
  pythonPath?: string;
  palacePath?: string;
  version?: string;
  autoUpdate?: boolean;
  autoProvision?: boolean;
}

/**
 * Single source of truth for path resolution (builtins, bootstrap's
 * dream integration, and doctor all go through here): defaults applied,
 * `~` expanded, made absolute.
 */
export function resolveMempalacePaths(
  section: MempalaceSection | undefined,
  home = homedir(),
): { pythonPath: string; palacePath: string } {
  return {
    pythonPath: resolve(
      expandHome(section?.pythonPath ?? files.mempalacePython, home),
    ),
    palacePath: resolve(expandHome(section?.palacePath ?? dirs.palace, home)),
  };
}

/** Injectable seams so unit tests can cover every OS and failure branch. */
export interface MempalaceProvisionDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  now?: () => number;
  home?: string;
  /** The Talon-owned interpreter path (default: files.mempalacePython). */
  defaultManagedPython?: string;
  statePath?: string;
  pathExists?: (p: string) => boolean;
}

interface HealthProbe {
  healthy: boolean;
  version?: string;
  error?: string;
}

async function probeHealth(exec: ExecFn, python: string): Promise<HealthProbe> {
  const result = await exec(python, ["-c", HEALTH_SNIPPET], {
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (result.ok) {
    const version = result.stdout.trim().split(/\s+/).pop();
    if (version) return { healthy: true, version };
  }
  return { healthy: false, error: failDetail(result) };
}

/** Classify an operator-managed install by its interpreter path. */
export function classifyExternalInstall(pythonPath: string): string {
  const p = pythonPath.replaceAll("\\", "/").toLowerCase();
  if (p.includes("/uv/tools/")) return "uv-tool";
  if (p.includes("/pipx/")) return "pipx";
  if (
    p.includes("conda") ||
    p.includes("miniforge") ||
    p.includes("mambaforge")
  ) {
    return "conda";
  }
  return "external";
}

/** The exact upgrade command for an operator-managed install's flavor. */
function upgradeHint(kind: string, python: string, target: string): string {
  if (kind === "uv-tool") {
    return `uv tool install --force 'mempalace==${target}'`;
  }
  if (kind === "pipx") return `pipx install --force 'mempalace==${target}'`;
  return `${python} -m pip install --upgrade 'mempalace==${target}'`;
}

/** Single-flight guard: hot-reload must not stack concurrent pip runs. */
let reconcileInFlight = false;

export async function provisionMempalace(
  section: MempalaceSection,
  deps: MempalaceProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const exec = deps.exec ?? runStep;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const home = deps.home ?? homedir();
  const pathExists = deps.pathExists ?? existsSync;
  const target = section.version ?? MEMPALACE_PINNED_VERSION;

  const { pythonPath: python, palacePath: palace } = resolveMempalacePaths(
    section,
    home,
  );
  const managedPython = resolve(
    deps.defaultManagedPython ?? files.mempalacePython,
  );
  const managed = python === managedPython;

  const probe = pathExists(python)
    ? await probeHealth(exec, python)
    : { healthy: false, error: "interpreter not found" };

  if (!managed) {
    return externalOutcome(python, target, probe, pathExists);
  }

  // ── Talon-owned venv from here on ──
  const statePath =
    deps.statePath ?? join(dirs.data, "mempalace-provision.json");
  const state = loadProvisionState(statePath);
  const venvDir = dirname(dirname(python));

  const ctx: ReconcileContext = {
    exec,
    platform,
    now,
    python,
    palace,
    venvDir,
    target,
    statePath,
    state,
    pathExists,
    previous: probe.healthy ? { version: probe.version! } : undefined,
  };

  if (probe.healthy && probe.version === target) {
    state.installedVersion = probe.version;
    markProvisionSuccess(statePath, state, target, now());
    const outcome: ProvisionOutcome = {
      status: "ready",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [],
    };
    await maybeMigratePalace(ctx, outcome);
    return outcome;
  }

  if (section.autoProvision === false) {
    return {
      status: probe.healthy ? "ready" : "failed",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [
        probe.healthy
          ? `installed ${probe.version}, pinned ${target} — autoProvision is off, run: ${python} -m pip install --upgrade 'mempalace==${target}'`
          : `mempalace not usable (${probe.error}) and autoProvision is off — create the venv manually (see README) or re-enable autoProvision`,
      ],
      error: probe.healthy ? undefined : probe.error,
    };
  }

  if (probe.healthy && section.autoUpdate === false) {
    return {
      status: "ready",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [
        `installed ${probe.version}, pinned ${target} — autoUpdate is off, upgrade manually when ready`,
      ],
    };
  }

  if (!shouldAttempt(state, target, now())) {
    const wait = Math.round(
      provisionBackoffMs(state.failureCount ?? 1) / 60_000,
    );
    const notice = `last provision attempt failed (${state.lastError ?? "unknown"}); retrying with backoff (≤${wait}min) or at next pin change`;
    return probe.healthy
      ? {
          status: "degraded",
          version: probe.version,
          kind: "managed-venv",
          actions: [],
          warnings: [notice],
        }
      : {
          status: "failed",
          kind: "managed-venv",
          actions: [],
          warnings: [notice],
          error: state.lastError,
        };
  }

  if (probe.healthy) {
    // Usable install at the wrong version: boot on it now, reconcile in
    // the background — the venv path is stable, so the next MCP spawn
    // picks the new version up without any further coordination.
    return {
      status: "ready",
      version: probe.version,
      kind: "managed-venv",
      actions: [],
      warnings: [
        `installed ${probe.version}, pinned ${target} — upgrading in the background`,
      ],
      background: () => runReconcileSingleFlight(ctx),
    };
  }

  // Broken or absent: provisioning is the only way to a working plugin,
  // so this path blocks (first boot pays the install once).
  return runReconcileSingleFlight(ctx);
}

function externalOutcome(
  python: string,
  target: string,
  probe: HealthProbe,
  pathExists: (p: string) => boolean,
): ProvisionOutcome {
  const kind = classifyExternalInstall(python);
  const hint = upgradeHint(kind, python, target);
  if (!pathExists(python)) {
    return {
      status: "failed",
      kind,
      actions: [],
      warnings: [
        `python not found at ${python} — this install is operator-managed (${kind}); fix the path or install with: ${hint}`,
      ],
      error: "interpreter not found",
    };
  }
  if (!probe.healthy) {
    return {
      status: "failed",
      kind,
      actions: [],
      warnings: [
        `mempalace not importable from ${python} (${probe.error}) — operator-managed (${kind}); install with: ${hint}`,
      ],
      error: probe.error,
    };
  }
  const warnings: string[] = [];
  if (compareVersions(probe.version!, target) < 0) {
    warnings.push(
      `installed ${probe.version}, Talon pins ${target} — operator-managed (${kind}), upgrade with: ${hint}`,
    );
  }
  return {
    status: "ready",
    version: probe.version,
    kind,
    actions: [],
    warnings,
  };
}

interface ReconcileContext {
  exec: ExecFn;
  platform: NodeJS.Platform;
  now: () => number;
  python: string;
  palace: string;
  venvDir: string;
  target: string;
  statePath: string;
  state: ProvisionState;
  pathExists: (p: string) => boolean;
  /** A working install that existed before this pass, if any. */
  previous?: { version: string };
}

async function runReconcileSingleFlight(
  ctx: ReconcileContext,
): Promise<ProvisionOutcome> {
  if (reconcileInFlight) {
    return {
      status: ctx.previous ? "degraded" : "failed",
      version: ctx.previous?.version,
      kind: "managed-venv",
      actions: [],
      warnings: ["a provisioning pass is already running — skipped"],
    };
  }
  reconcileInFlight = true;
  try {
    return await reconcile(ctx);
  } finally {
    reconcileInFlight = false;
  }
}

async function reconcile(ctx: ReconcileContext): Promise<ProvisionOutcome> {
  const { exec, platform, python, venvDir, target, pathExists } = ctx;
  const actions: string[] = [];
  const warnings: string[] = [];
  let recreatedThisPass = false;

  const fail = (error: string): ProvisionOutcome => {
    markProvisionFailure(ctx.statePath, ctx.state, target, error, ctx.now());
    if (ctx.previous) {
      warnings.push(
        `upgrade to ${target} failed (${error}) — staying on working ${ctx.previous.version}, will retry with backoff`,
      );
      return {
        status: "degraded",
        version: ctx.previous.version,
        kind: "managed-venv",
        actions,
        warnings,
      };
    }
    return {
      status: "failed",
      kind: "managed-venv",
      actions,
      warnings,
      error,
    };
  };

  const recreateVenv = async (): Promise<string | undefined> => {
    const existedBefore = pathExists(venvDir);
    const base = await findBasePython(exec, platform, PYTHON_MIN);
    if (!base) {
      return `no python >=${PYTHON_MIN.major}.${PYTHON_MIN.minor} found on PATH — install one, or point mempalace.pythonPath at an environment you manage`;
    }
    // --clear empties a broken venv in place; no recursive delete needed.
    const created = await exec(
      base.command,
      [...base.args, "-m", "venv", "--clear", venvDir],
      { timeoutMs: VENV_TIMEOUT_MS },
    );
    if (!created.ok) {
      // Debian/Ubuntu ship python3 without the venv module; the failure
      // names ensurepip and the fix is a distro package, not pip.
      const hint = /ensurepip|venv/i.test(created.stderr)
        ? " — on Debian/Ubuntu: sudo apt install python3-venv"
        : "";
      return `venv creation failed: ${failDetail(created)}${hint}`;
    }
    recreatedThisPass = true;
    actions.push(
      `${existedBefore ? "recreated" : "created"} venv at ${venvDir} (python ${base.version})`,
    );
    return undefined;
  };

  const pipInstall = async (forceReinstall: boolean) =>
    exec(
      python,
      [
        "-m",
        "pip",
        "install",
        "--upgrade",
        ...(forceReinstall ? ["--force-reinstall"] : []),
        `mempalace==${target}`,
      ],
      {
        timeoutMs: PIP_TIMEOUT_MS,
        env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" },
      },
    );

  // Step 1 — ensure an interpreter exists at all.
  if (!pathExists(python)) {
    const err = await recreateVenv();
    if (err) return fail(err);
  }

  // Step 2 — install/upgrade. A pass that started from a broken-but-present
  // install force-reinstalls, which repairs half-written site-packages.
  const brokenInstall = !ctx.previous && !recreatedThisPass;
  let installed = await pipInstall(brokenInstall);

  // Step 3 — heal ladder. First rung: pip itself may be missing/broken.
  if (!installed.ok) {
    await exec(python, ["-m", "ensurepip", "--upgrade"], {
      timeoutMs: VENV_TIMEOUT_MS,
    });
    await exec(python, ["-m", "pip", "install", "--upgrade", "pip"], {
      timeoutMs: VENV_TIMEOUT_MS,
      env: { PIP_DISABLE_PIP_VERSION_CHECK: "1" },
    });
    installed = await pipInstall(brokenInstall);
  }

  // Second rung: rebuild the whole venv — but never sacrifice a working
  // install to do it; a failed upgrade keeps serving the old version.
  if (!installed.ok && !recreatedThisPass && !ctx.previous) {
    const err = await recreateVenv();
    if (!err) installed = await pipInstall(false);
  }

  if (!installed.ok) return fail(failDetail(installed));

  // Step 4 — trust nothing: verify the interpreter now serves the target.
  const verify = await probeHealth(exec, python);
  if (!verify.healthy) {
    return fail(`installed but not importable: ${verify.error}`);
  }
  if (verify.version !== target) {
    return fail(
      `expected ${target} after install, found ${verify.version ?? "nothing"}`,
    );
  }

  actions.push(
    ctx.previous
      ? `upgraded mempalace ${ctx.previous.version} → ${target}`
      : `installed mempalace ${target}`,
  );
  ctx.state.installedVersion = target;
  markProvisionSuccess(ctx.statePath, ctx.state, target, ctx.now());

  const outcome: ProvisionOutcome = {
    status: "ready",
    version: target,
    kind: "managed-venv",
    actions,
    warnings,
  };
  await maybeMigratePalace(ctx, outcome);
  return outcome;
}

/**
 * One-time palace data migrations, applied only to palaces that already
 * hold data (a chroma store) and recorded in the state ledger so they
 * run exactly once per deployment. `migrate-wings` itself is idempotent,
 * so a lost ledger costs one harmless re-run, never data.
 */
async function maybeMigratePalace(
  ctx: ReconcileContext,
  outcome: ProvisionOutcome,
): Promise<void> {
  if (ctx.state.migrations?.[WING_MIGRATION]) return;
  if (!ctx.pathExists(join(ctx.palace, "chroma.sqlite3"))) return;

  const result = await ctx.exec(
    ctx.python,
    ["-m", "mempalace", "--palace", ctx.palace, "migrate-wings", "--yes"],
    { timeoutMs: MIGRATE_TIMEOUT_MS },
  );
  if (result.ok) {
    ctx.state.migrations = {
      ...ctx.state.migrations,
      [WING_MIGRATION]: new Date(ctx.now()).toISOString(),
    };
    saveProvisionState(ctx.statePath, ctx.state);
    const summary =
      result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) => l.startsWith("Migrated") || l.includes("nothing to migrate"),
        )
        .pop() ?? "done";
    outcome.actions.push(`palace wing-name migration: ${summary}`);
  } else {
    outcome.warnings.push(
      `palace wing-name migration failed (${failDetail(result)}) — data untouched, will retry next provision pass`,
    );
  }
}

/**
 * Read-only doctor inspection: version vs pin, flavor, importability.
 * Never mutates — a drifted managed venv reports "reconciles at next
 * talon start", which is the provisioner's job, not doctor's.
 */
export async function inspectMempalace(
  section: MempalaceSection,
  deps: MempalaceProvisionDeps = {},
): Promise<DoctorCheck[]> {
  const exec = deps.exec ?? runStep;
  const pathExists = deps.pathExists ?? existsSync;
  const home = deps.home ?? homedir();
  const { pythonPath: python } = resolveMempalacePaths(section, home);
  const pin = section.version ?? MEMPALACE_PINNED_VERSION;
  const managed =
    python === resolve(deps.defaultManagedPython ?? files.mempalacePython);
  const kind = managed ? "managed venv" : classifyExternalInstall(python);

  if (!pathExists(python)) {
    return [
      {
        label: `MemPalace runtime missing (${kind})`,
        status: managed ? "warn" : "fail",
        detail: managed
          ? `provisions automatically at next talon start (pin ${pin})`
          : `python not found at ${python}`,
        issue: true,
      },
    ];
  }
  const probe = await probeHealth(exec, python);
  if (!probe.healthy) {
    return [
      {
        label: `MemPalace broken (${kind})`,
        status: "warn",
        detail: managed
          ? "self-heals at next talon start"
          : `mempalace not importable from ${python} (${probe.error})`,
        issue: true,
      },
    ];
  }
  if (probe.version === pin) {
    return [{ label: `MemPalace ${probe.version} (${kind})`, status: "ok" }];
  }
  return [
    {
      label: `MemPalace ${probe.version}, pinned ${pin} (${kind})`,
      status: "warn",
      detail: managed
        ? "reconciles at next talon start"
        : "operator-managed install — upgrade when ready",
      issue: managed,
    },
  ];
}
