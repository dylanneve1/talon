/**
 * MemPalace installation and sanity checks.
 *
 * Responsible for onboarding automation:
 *   - Creating the Python venv if it's missing (optional)
 *   - Installing mempalace at the Talon-supported version (optional)
 *   - Verifying the installed version satisfies MEMPALACE_MIN_VERSION
 *   - Surfacing actionable errors when any step fails
 *
 * The "pinned" install target is the version Talon ships against — we
 * know its MCP server protocol, known tools, and bug profile. `MIN_VERSION`
 * is the floor we refuse to start below.
 */

import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Exact mempalace release Talon ships and installs against when autoInstall
 * is enabled. Bump this when the plugin is tested and verified against a
 * newer release — not before.
 */
export const MEMPALACE_INSTALL_TARGET = "3.3.2";

/**
 * Minimum mempalace version Talon will accept. Anything below this is
 * unsupported and will fail validateConfig so the user sees a clear error.
 */
export const MEMPALACE_MIN_VERSION = "3.3.2";

/** Parsed semver triplet — non-semver releases fail the check. */
export type SemVer = { major: number; minor: number; patch: number };

/** Parse "X.Y.Z" into {major, minor, patch}. Returns null if invalid. */
export function parseSemVer(raw: string): SemVer | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Compare two SemVer values. Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemVer(a: SemVer, b: SemVer): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** True when `version` satisfies `>= minimum`. */
export function isVersionSupported(version: string, minimum: string): boolean {
  const parsed = parseSemVer(version);
  const floor = parseSemVer(minimum);
  if (!parsed || !floor) return false;
  return compareSemVer(parsed, floor) >= 0;
}

export type InstallStatus = {
  /** True when mempalace is importable at a supported version. */
  ok: boolean;
  /** Detected installed version, or null if import failed. */
  version: string | null;
  /** Human-readable steps taken during this ensure() call. */
  steps: string[];
  /** Populated when ok=false — actionable error for the user. */
  error?: string;
};

export type EnsureOptions = {
  /** Python binary path to probe and, if needed, install against. */
  pythonPath: string;
  /**
   * If true, missing venv / missing package / outdated version triggers
   * automatic remediation (create venv, pip install, upgrade). When false,
   * the function only diagnoses and returns an error.
   */
  autoInstall: boolean;
  /**
   * When creating a fresh venv, which python executable to bootstrap with.
   * Defaults to `python3` on POSIX, `python` on Windows.
   */
  bootstrapPython?: string;
  /** Install target version. Defaults to {@link MEMPALACE_INSTALL_TARGET}. */
  installTarget?: string;
  /** Minimum acceptable version. Defaults to {@link MEMPALACE_MIN_VERSION}. */
  minVersion?: string;
  /** Timeout for each subprocess call, ms. Default 120s (pip can be slow). */
  timeoutMs?: number;
  /** Injected for tests — defaults to Node's promisified execFile. */
  execFileImpl?: typeof execFile;
  /** Injected for tests — defaults to fs.existsSync. */
  existsSyncImpl?: (path: string) => boolean;
  /** Injected for tests — defaults to checking for pyvenv.cfg near python. */
  isVenvImpl?: (pythonPath: string) => boolean;
};

/** True when the directory containing `pythonPath` has a sibling `pyvenv.cfg`. */
export function looksLikeVenv(pythonPath: string): boolean {
  // Unix: venv/bin/python   → venv/pyvenv.cfg
  // Windows: venv\Scripts\python.exe → venv\pyvenv.cfg
  const binDir = dirname(pythonPath);
  const venvRoot = dirname(binDir);
  return existsSync(`${venvRoot}/pyvenv.cfg`);
}

/**
 * Run `python -c "import mempalace; print(mempalace.__version__)"` and
 * return the version string, or null if import fails for any reason.
 */
export async function detectMempalaceVersion(
  pythonPath: string,
  execFileImpl: typeof execFile = execFile,
  timeoutMs = 20_000,
): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl(
      pythonPath,
      [
        "-c",
        "import mempalace, sys; sys.stdout.write(getattr(mempalace, '__version__', ''))",
      ],
      { timeout: timeoutMs },
    );
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Ensure mempalace is installed at a supported version.
 *
 * When autoInstall=true this is self-healing: missing venv → created,
 * missing package → pip install, outdated → pip install --upgrade.
 * When autoInstall=false the function is purely diagnostic.
 */
export async function ensureMempalaceInstalled(
  opts: EnsureOptions,
): Promise<InstallStatus> {
  const {
    pythonPath,
    autoInstall,
    bootstrapPython = process.platform === "win32" ? "python" : "python3",
    installTarget = MEMPALACE_INSTALL_TARGET,
    minVersion = MEMPALACE_MIN_VERSION,
    timeoutMs = 120_000,
    execFileImpl = execFile,
    existsSyncImpl = existsSync,
    isVenvImpl = looksLikeVenv,
  } = opts;

  const steps: string[] = [];

  // 1. Python binary
  if (!existsSyncImpl(pythonPath)) {
    if (!autoInstall) {
      return {
        ok: false,
        version: null,
        steps,
        error: `Python binary not found at ${pythonPath}. Set "pythonPath" to a valid interpreter or enable mempalace.autoInstall to create a venv with ${bootstrapPython}.`,
      };
    }
    // Try to create a venv at the parent-of-parent directory
    const binDir = dirname(pythonPath);
    const venvRoot = dirname(binDir);
    steps.push(`creating venv at ${venvRoot} with ${bootstrapPython}`);
    try {
      await execFileImpl(bootstrapPython, ["-m", "venv", venvRoot], {
        timeout: timeoutMs,
      });
    } catch (err) {
      return {
        ok: false,
        version: null,
        steps,
        error: `Failed to create venv at ${venvRoot} using ${bootstrapPython}: ${(err as Error).message}`,
      };
    }
    if (!existsSyncImpl(pythonPath)) {
      return {
        ok: false,
        version: null,
        steps,
        error: `Venv was created at ${venvRoot} but expected python binary is still missing at ${pythonPath}.`,
      };
    }
  } else if (!isVenvImpl(pythonPath)) {
    // Not a venv. Allow it — user may have a system Python with mempalace
    // installed globally — but note it in steps for diagnostics.
    steps.push(`using non-venv python at ${pythonPath}`);
  }

  // 2. Detect current version
  let currentVersion = await detectMempalaceVersion(
    pythonPath,
    execFileImpl,
    Math.min(timeoutMs, 20_000),
  );

  // 3. Install / upgrade if needed. Three trigger cases:
  //   - missing          → install from scratch
  //   - below floor      → upgrade (mandatory, regardless of autoInstall
  //                        we can only surface an error in off-mode)
  //   - off-target       → realign to the tested pin. Only actioned when
  //                        autoInstall is on; in off-mode we let a
  //                        user-chosen newer-patch stick if it satisfies
  //                        the floor.
  const needsInstall = currentVersion === null;
  const needsUpgrade =
    currentVersion !== null && !isVersionSupported(currentVersion, minVersion);
  const needsAlign =
    currentVersion !== null &&
    !needsUpgrade &&
    currentVersion !== installTarget &&
    autoInstall;

  if (needsInstall || needsUpgrade || needsAlign) {
    if (!autoInstall) {
      // needsAlign requires autoInstall=true, so here we only hit install
      // or below-floor.
      return {
        ok: false,
        version: currentVersion,
        steps,
        error: needsInstall
          ? `mempalace not installed at ${pythonPath}. Run: ${pythonPath} -m pip install 'mempalace==${installTarget}' — or enable mempalace.autoInstall.`
          : `mempalace ${currentVersion} is below the supported minimum ${minVersion}. Run: ${pythonPath} -m pip install --upgrade 'mempalace==${installTarget}' — or enable mempalace.autoInstall.`,
      };
    }
    const verb = needsInstall
      ? "installing"
      : needsUpgrade
        ? "upgrading"
        : "aligning";
    steps.push(
      `${verb} mempalace==${installTarget}${currentVersion ? ` (was ${currentVersion})` : ""}`,
    );
    try {
      await execFileImpl(
        pythonPath,
        ["-m", "pip", "install", "--upgrade", `mempalace==${installTarget}`],
        { timeout: timeoutMs },
      );
    } catch (err) {
      const stderr = (err as { stderr?: string | Buffer }).stderr ?? "";
      const stderrText =
        typeof stderr === "string"
          ? stderr
          : Buffer.isBuffer(stderr)
            ? stderr.toString("utf-8")
            : "";
      return {
        ok: false,
        version: currentVersion,
        steps,
        error: `pip install mempalace==${installTarget} failed: ${(err as Error).message}${stderrText ? ` — ${stderrText.trim().slice(0, 400)}` : ""}`,
      };
    }
    currentVersion = await detectMempalaceVersion(
      pythonPath,
      execFileImpl,
      Math.min(timeoutMs, 20_000),
    );
  }

  // 4. Final version check
  if (currentVersion === null) {
    return {
      ok: false,
      version: null,
      steps,
      error: `mempalace import failed after install attempt. Run manually: ${pythonPath} -m pip install 'mempalace==${installTarget}' and check for errors.`,
    };
  }
  if (!isVersionSupported(currentVersion, minVersion)) {
    return {
      ok: false,
      version: currentVersion,
      steps,
      error: `mempalace ${currentVersion} is below the supported minimum ${minVersion}. Upgrade with: ${pythonPath} -m pip install --upgrade 'mempalace==${installTarget}'`,
    };
  }

  steps.push(`mempalace ${currentVersion} ready`);
  return { ok: true, version: currentVersion, steps };
}
