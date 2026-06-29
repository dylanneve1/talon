/**
 * Self-update for git-checkout deployments (the `/update` command).
 *
 * Only meaningful when Talon runs from a git clone in a developer
 * build: it pulls the latest code from a configurable remote/branch,
 * reinstalls dependencies, runs any extra setup commands, and lets
 * the caller respawn the process. Packaged/binary builds have no
 * source tree on disk, so {@link getRepoRoot} returns `null` and the
 * `/update` command is never registered.
 *
 * The update force-syncs the checkout to the remote branch with
 * `git reset --hard` (plus `git clean -fd`), discarding any local edits
 * or diverged commits. A bot host is meant to mirror the remote exactly,
 * so "become whatever upstream says" is the right model — and it means a
 * stray local change (a touched lockfile, an experiment left in the tree)
 * can never leave the deployment un-updatable, which is what the old
 * `pull --ff-only` did (it aborts on any dirty/diverged tree). `.gitignore`
 * is respected (no `-x`), so node_modules, secrets and local config survive.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Tuning knobs for {@link runSelfUpdate}. */
export interface UpdateOptions {
  /** Git remote to pull from (default `origin`). */
  remote?: string;
  /** Branch to pull (default `main`). */
  branch?: string;
  /**
   * Extra shell commands run in the repo root after `npm install`
   * and before restart (e.g. a build step). Each runs via `sh -c`.
   */
  setup?: readonly string[];
  /** Override the repo root (tests). Defaults to {@link getRepoRoot}. */
  repoRoot?: string;
  /** Injectable command runner (tests). */
  runner?: CommandRunner;
}

/** One executed step in an update run. */
export interface UpdateStep {
  label: string;
  ok: boolean;
  output: string;
}

/** Outcome of an update run. */
export interface UpdateResult {
  ok: boolean;
  repoRoot: string | null;
  steps: UpdateStep[];
  /** Commit before the pull (short SHA), if known. */
  before?: string;
  /** Commit after the pull (short SHA), if known. */
  after?: string;
  /** True when the pull moved HEAD — i.e. a restart is warranted. */
  changed: boolean;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ ok: boolean; output: string }>;

const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 300_000;
const SETUP_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BUFFER = 16 * 1024 * 1024;

const defaultRunner: CommandRunner = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      { cwd, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BUFFER },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        resolve({
          ok: !err,
          output: err && !output ? err.message : output,
        });
      },
    );
  });

/**
 * Walk up from this module's location looking for a directory that
 * is both a git checkout (`.git` present) and an npm package
 * (`package.json` present). Returns that directory, or `null` when
 * the process is not running from a source checkout (packaged binary,
 * global install, etc.).
 */
export function getRepoRoot(startDir?: string): string | null {
  let dir: string;
  try {
    dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, ".git")) &&
      existsSync(join(dir, "package.json"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function shortSha(sha: string): string {
  return sha.trim().slice(0, 12);
}

/**
 * Force-sync the checkout to the remote branch (`git reset --hard` +
 * `git clean -fd`), reinstall deps, run setup commands. Stops at the
 * first failing step and never restarts on its own — the caller decides
 * (typically: respawn only when `changed` is true).
 */
export async function runSelfUpdate(
  opts: UpdateOptions = {},
): Promise<UpdateResult> {
  const repoRoot = opts.repoRoot ?? getRepoRoot();
  const steps: UpdateStep[] = [];
  if (!repoRoot) {
    return {
      ok: false,
      repoRoot: null,
      steps,
      changed: false,
      error: "Not running from a git checkout — nothing to update.",
    };
  }

  const remote = opts.remote?.trim() || "origin";
  const branch = opts.branch?.trim() || "main";
  const run = opts.runner ?? defaultRunner;

  const record = async (
    label: string,
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<UpdateStep> => {
    const { ok, output } = await run(cmd, args, repoRoot, timeoutMs);
    const step: UpdateStep = { label, ok, output };
    steps.push(step);
    return step;
  };

  const fail = (error: string, before?: string): UpdateResult => ({
    ok: false,
    repoRoot,
    steps,
    before,
    changed: false,
    error,
  });

  // Snapshot current HEAD so we can tell whether the update moved it.
  const head = await record(
    "rev-parse HEAD",
    "git",
    ["rev-parse", "HEAD"],
    GIT_TIMEOUT_MS,
  );
  if (!head.ok) return fail(`Failed to read current commit: ${head.output}`);
  const before = shortSha(head.output);

  const fetch = await record(
    `fetch ${remote} ${branch}`,
    "git",
    ["fetch", remote, branch],
    GIT_TIMEOUT_MS,
  );
  if (!fetch.ok) return fail(`git fetch failed: ${fetch.output}`, before);

  // Force the checkout to exactly match the freshly-fetched remote
  // branch, discarding ANY local edits or diverged commits. The old
  // `pull --ff-only` aborted here whenever the tree was dirty, leaving the
  // deployment stuck; a bot host is meant to mirror the remote, so resetting
  // to it is both correct and reliable.
  const reset = await record(
    `reset --hard ${remote}/${branch}`,
    "git",
    ["reset", "--hard", `${remote}/${branch}`],
    GIT_TIMEOUT_MS,
  );
  if (!reset.ok) {
    return fail(
      `git reset --hard ${remote}/${branch} failed: ${reset.output}`,
      before,
    );
  }

  // Drop untracked files too so the tree is pristine and a future update
  // can't collide with a leftover untracked path. `.gitignore` is respected
  // (no `-x`), so node_modules / secrets / local config are preserved.
  // Best-effort: a clean failure must not abort an otherwise-good update.
  await record("clean -fd", "git", ["clean", "-fd"], GIT_TIMEOUT_MS);

  const headAfter = await record(
    "rev-parse HEAD (post-reset)",
    "git",
    ["rev-parse", "HEAD"],
    GIT_TIMEOUT_MS,
  );
  const after = headAfter.ok ? shortSha(headAfter.output) : before;
  const changed = after !== before;

  // Nothing moved — skip the expensive install/setup and tell the
  // caller no restart is needed.
  if (!changed) {
    return { ok: true, repoRoot, steps, before, after, changed: false };
  }

  const install = await record(
    "npm install",
    "npm",
    ["install"],
    INSTALL_TIMEOUT_MS,
  );
  if (!install.ok) {
    return {
      ok: false,
      repoRoot,
      steps,
      before,
      after,
      changed,
      error: `npm install failed: ${install.output}`,
    };
  }

  for (const cmd of opts.setup ?? []) {
    const trimmed = cmd.trim();
    if (!trimmed) continue;
    const setup = await record(
      `setup: ${trimmed}`,
      "sh",
      ["-c", trimmed],
      SETUP_TIMEOUT_MS,
    );
    if (!setup.ok) {
      return {
        ok: false,
        repoRoot,
        steps,
        before,
        after,
        changed,
        error: `setup command failed (${trimmed}): ${setup.output}`,
      };
    }
  }

  return { ok: true, repoRoot, steps, before, after, changed: true };
}
