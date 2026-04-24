/**
 * MemPalace self-heal.
 *
 * Called unconditionally during plugin init when `mempalace.enabled` is true.
 * No opt-in flag — if the plugin is enabled, we make sure it works.
 *
 * Two operating modes, chosen by whether the user supplied a custom
 * `pythonPath` in config:
 *
 *   "managed" (default):
 *     - We own `~/.talon/mempalace-venv`. On heal:
 *         create venv if missing → pip install mempalace==PIN → verify import
 *     - Safe to modify anything under our venv root.
 *
 *   "verify-only" (user set `pythonPath`):
 *     - We never touch the user's Python environment.
 *     - Heal runs probes only: does the interpreter exist, can it import
 *       mempalace at a supported version? Downgrade to `degraded` if not.
 *
 * Both modes return the same HealResult shape so the core runner doesn't
 * need to branch.
 */

import { dirname } from "node:path";
import {
  runProbe,
  runStreaming,
  type RunOptions,
} from "../common/subprocess.js";
import { isAtLeast, isExactMatch, parseSemVer } from "../common/semver.js";
import type { HealContext, HealFn, HealResult } from "../common/lifecycle.js";
import type { PluginError } from "../common/errors.js";

/**
 * Exact mempalace release Talon ships and installs against. Bump this
 * only after the full smoke matrix (Linux/macOS/Windows × 3.11/3.12)
 * passes against the new version.
 */
export const MEMPALACE_TARGET = "3.3.2";

/**
 * Minimum mempalace version Talon will accept without remediation.
 * Must parse as semver. Below this we either upgrade (managed) or
 * downgrade our status to `degraded` (verify-only).
 */
export const MEMPALACE_FLOOR = "3.3.2";

export interface MempalaceHealOpts {
  /** Absolute python executable path. */
  pythonPath: string;
  /**
   * True when Talon owns the venv (default path). When false we never
   * invoke pip — we only probe.
   */
  managed: boolean;
  /**
   * Bootstrap python for creating a fresh venv (managed mode only).
   * Defaults to `python3` on POSIX, `python` on Windows.
   */
  bootstrapPython?: string;
}

type RunOpts = Omit<RunOptions, "tracker">;

function runOpts(
  ctx: HealContext,
  tracker: RunOptions["tracker"],
  timeoutMs: number,
  extra?: RunOpts,
): RunOptions {
  return {
    timeoutMs,
    tracker,
    env: extra?.env,
    cwd: extra?.cwd,
    spawnImpl: ctx.spawnImpl,
  };
}

const VERSION_PROBE_ARGS = [
  "-c",
  "import sys; " +
    "sys.stdout.write(__import__('mempalace').__version__) " +
    "if __import__('importlib.util', fromlist=['find_spec']).find_spec('mempalace') " +
    "else sys.exit(42)",
] as const;

const IMPORT_MCP_SERVER_ARGS = ["-c", "import mempalace.mcp_server"] as const;

async function detectVersion(
  pythonPath: string,
  ctx: HealContext,
): Promise<string | null> {
  // Dedicated probe — we don't want the probe output polluting the step
  // tracker. Silent tracker swallows stream lines.
  const probe = await runProbe(pythonPath, VERSION_PROBE_ARGS, {
    timeoutMs: 20_000,
    spawnImpl: ctx.spawnImpl,
  });
  if (probe === null) return null;
  const trimmed = probe.trim();
  // Must look like at least X.Y.Z — guards against the rare case where
  // mempalace is importable but missing __version__ (shouldn't happen in
  // any release we support, but cheap to be defensive).
  return parseSemVer(trimmed) ? trimmed : null;
}

function failed(
  identifier: string,
  error: PluginError,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "failed", identifier, error, elapsedMs, summary };
}

function degraded(
  identifier: string,
  error: PluginError,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "degraded", identifier, error, elapsedMs, summary };
}

function healthy(
  identifier: string,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "healthy", identifier, elapsedMs, summary };
}

/** Build the managed-mode heal function for a specific config. */
export function createMempalaceHeal(opts: MempalaceHealOpts): HealFn {
  return async (ctx: HealContext): Promise<HealResult> => {
    const { logger } = ctx;
    const existsSync =
      ctx.existsSyncImpl ??
      ((await import("node:fs")).existsSync as (path: string) => boolean);
    const summary: string[] = [];
    const start = Date.now();

    const identifier = () => `mempalace`;

    // ── Step 1: verify / create venv (managed only) ───────────────────
    if (opts.managed) {
      const step = logger.step("venv");
      const venvRoot = dirname(dirname(opts.pythonPath));
      if (existsSync(opts.pythonPath)) {
        step.ok(`reusing ${venvRoot}`);
        summary.push(`venv: ${venvRoot}`);
      } else {
        const bootstrap =
          opts.bootstrapPython ??
          (process.platform === "win32" ? "python" : "python3");
        step.stream(`creating venv at ${venvRoot} with ${bootstrap} -m venv`);
        const result = await runStreaming(
          bootstrap,
          ["-m", "venv", venvRoot],
          runOpts(ctx, step, 120_000),
        );
        if (!result.ok) {
          step.fail(result.error?.message ?? "venv creation failed");
          return failed(
            identifier(),
            result.error ?? {
              kind: "unknown",
              message: "venv creation failed",
              hint: `run: ${bootstrap} -m venv ${venvRoot}`,
            },
            Date.now() - start,
            summary,
          );
        }
        if (!existsSync(opts.pythonPath)) {
          step.fail(
            `${bootstrap} reported success but ${opts.pythonPath} still missing`,
          );
          return failed(
            identifier(),
            {
              kind: "unknown",
              message: "venv created but python binary is missing",
              hint: "check the bootstrap python installation",
              details: `expected: ${opts.pythonPath}`,
            },
            Date.now() - start,
            summary,
          );
        }
        step.ok(`created ${venvRoot}`);
        summary.push(`venv: ${venvRoot} (new)`);
      }
    } else {
      const step = logger.step("venv");
      if (!existsSync(opts.pythonPath)) {
        step.fail(`pythonPath ${opts.pythonPath} does not exist`);
        return failed(
          identifier(),
          {
            kind: "executable-not-found",
            message: `python binary not found at ${opts.pythonPath}`,
            hint: "set mempalace.pythonPath to a valid interpreter, or remove it so Talon manages a venv",
          },
          Date.now() - start,
          summary,
        );
      }
      step.skip("user-provided python (verify-only mode)");
      summary.push(`python: ${opts.pythonPath} (user-provided)`);
    }

    // ── Step 2: probe installed version ───────────────────────────────
    const probeStep = logger.step("probe mempalace version");
    const current = await detectVersion(opts.pythonPath, ctx);
    probeStep.ok(current ? `current: ${current}` : "not installed");

    // ── Step 3: install / align (managed only) ────────────────────────
    let finalVersion = current;
    const installStep = logger.step(`install mempalace==${MEMPALACE_TARGET}`);
    const needsInstall = current === null;
    const needsAlign =
      current !== null && !isExactMatch(current, MEMPALACE_TARGET);

    if (needsInstall || needsAlign) {
      if (!opts.managed) {
        // Verify-only mode: below-floor is degraded, below-target-but-above-
        // floor is acceptable.
        if (!current) {
          installStep.fail(
            "mempalace is not installed at user-provided python",
          );
          // Note: kind is "unknown" rather than "executable-not-found" —
          // the Python executable exists, it's the *package* that's missing.
          // "executable-not-found" is reserved for missing binaries and
          // would mislead both user hints and any future telemetry slicing.
          return failed(
            identifier(),
            {
              kind: "unknown",
              message:
                "mempalace package is not installed in the user-provided Python interpreter",
              hint: `install it with: ${opts.pythonPath} -m pip install 'mempalace==${MEMPALACE_TARGET}'`,
            },
            Date.now() - start,
            summary,
          );
        }
        if (!isAtLeast(current, MEMPALACE_FLOOR)) {
          installStep.fail(
            `user-provided mempalace ${current} is below floor ${MEMPALACE_FLOOR}`,
          );
          return degraded(
            `mempalace ${current}`,
            {
              kind: "version-mismatch",
              message: `mempalace ${current} is below floor ${MEMPALACE_FLOOR}`,
              hint: `upgrade manually: ${opts.pythonPath} -m pip install --upgrade 'mempalace==${MEMPALACE_TARGET}'`,
            },
            Date.now() - start,
            summary,
          );
        }
        installStep.skip(
          `verify-only mode; drift from pin (${current} vs ${MEMPALACE_TARGET}) tolerated`,
        );
        summary.push(`mempalace: ${current} (above floor, off-pin)`);
      } else {
        const verb = needsInstall ? "installing" : "aligning";
        const wasClause = current ? ` (was ${current})` : "";
        installStep.stream(
          `pip install --upgrade mempalace==${MEMPALACE_TARGET}${wasClause}`,
        );
        const result = await runStreaming(
          opts.pythonPath,
          [
            "-m",
            "pip",
            "install",
            "--upgrade",
            "--disable-pip-version-check",
            `mempalace==${MEMPALACE_TARGET}`,
          ],
          runOpts(ctx, installStep, 5 * 60_000),
        );
        if (!result.ok) {
          installStep.fail(result.error?.message ?? "pip install failed");
          return failed(
            identifier(),
            result.error ?? {
              kind: "unknown",
              message: "pip install failed",
              hint: "re-run with talon logs -f to see streamed pip output",
            },
            Date.now() - start,
            summary,
          );
        }
        installStep.ok(`${verb} → ${MEMPALACE_TARGET}${wasClause}`);
        summary.push(`mempalace: ${MEMPALACE_TARGET}${wasClause}`);
        finalVersion = await detectVersion(opts.pythonPath, ctx);
      }
    } else {
      installStep.skip(`already at pin ${MEMPALACE_TARGET}`);
      summary.push(`mempalace: ${current}`);
    }

    // ── Step 4: final version verification ────────────────────────────
    const verifyStep = logger.step("verify final version");
    if (!finalVersion) {
      verifyStep.fail("import returned no version after install");
      return failed(
        identifier(),
        {
          kind: "unknown",
          message: "mempalace import failed after install",
          hint: `try manually: ${opts.pythonPath} -c 'import mempalace; print(mempalace.__version__)'`,
        },
        Date.now() - start,
        summary,
      );
    }
    if (!isAtLeast(finalVersion, MEMPALACE_FLOOR)) {
      verifyStep.fail(`${finalVersion} is below floor ${MEMPALACE_FLOOR}`);
      return failed(
        `mempalace ${finalVersion}`,
        {
          kind: "version-mismatch",
          message: `mempalace ${finalVersion} is below supported floor ${MEMPALACE_FLOOR}`,
          hint: `retry heal, or upgrade manually: ${opts.pythonPath} -m pip install --upgrade 'mempalace==${MEMPALACE_TARGET}'`,
        },
        Date.now() - start,
        summary,
      );
    }
    verifyStep.ok(`mempalace ${finalVersion} meets floor ${MEMPALACE_FLOOR}`);

    // ── Step 5: verify mcp_server submodule importable ────────────────
    const mcpStep = logger.step("verify mempalace.mcp_server import");
    const mcpResult = await runStreaming(
      opts.pythonPath,
      Array.from(IMPORT_MCP_SERVER_ARGS),
      runOpts(ctx, mcpStep, 20_000),
    );
    if (!mcpResult.ok) {
      mcpStep.fail(
        mcpResult.error?.message ?? "mempalace.mcp_server import failed",
      );
      return failed(
        `mempalace ${finalVersion}`,
        mcpResult.error ?? {
          kind: "unknown",
          message: "mempalace.mcp_server import failed",
          hint: "reinstall mempalace; the MCP submodule should always ship with the package",
        },
        Date.now() - start,
        summary,
      );
    }
    mcpStep.ok();

    return healthy(`mempalace ${finalVersion}`, Date.now() - start, summary);
  };
}
