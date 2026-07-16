/**
 * Install-source resolution shared by `talon plugin install` and
 * `talon skill install`.
 *
 * One grammar for both commands, checked in order:
 *
 *   1. an existing local path                → { kind: "local" }
 *   2. a git URL (scheme, `git@`, or `.git`) → { kind: "git" }
 *   3. `owner/repo[/subpath]` shorthand      → { kind: "git" } on github.com
 *   4. anything else                         → { kind: "other" } — the caller
 *      decides (plugins treat it as an npm spec, skills reject it)
 *
 * Cloning always uses `--depth=1` (installs never need history) and spawns
 * `git`/`npm` via cross-spawn, which resolves the `.cmd`/`.exe` shims on
 * Windows — never assume a POSIX shell here.
 */

import crossSpawn from "cross-spawn";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type ResolvedSource =
  | { kind: "local"; dir: string }
  | { kind: "git"; url: string; subpath?: string }
  | { kind: "other"; raw: string };

const GIT_URL_RE = /^(https?|git|ssh):\/\//;
/** `owner/repo` or `owner/repo/sub/path` — never an npm scope (`@…`). */
const GITHUB_SHORTHAND_RE =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^\s/]+)*)$/;

export function resolveSource(raw: string): ResolvedSource {
  const trimmed = raw.trim();
  if (existsSync(resolve(trimmed))) {
    return { kind: "local", dir: resolve(trimmed) };
  }
  if (
    GIT_URL_RE.test(trimmed) ||
    trimmed.startsWith("git@") ||
    trimmed.endsWith(".git")
  ) {
    return { kind: "git", url: trimmed };
  }
  if (!trimmed.startsWith("@")) {
    const match = GITHUB_SHORTHAND_RE.exec(trimmed);
    if (match) {
      const [, owner, repo, rest] = match;
      return {
        kind: "git",
        url: `https://github.com/${owner}/${repo}.git`,
        ...(rest ? { subpath: rest.slice(1) } : {}),
      };
    }
  }
  return { kind: "other", raw: trimmed };
}

export type CommandOutcome = { ok: true } | { ok: false; error: string };

/**
 * Run a tool from PATH synchronously. `inherit` streams output to the
 * terminal (npm installs); otherwise stderr is captured for the error.
 */
export function runTool(
  tool: string,
  args: string[],
  options: { cwd?: string; inherit?: boolean } = {},
): CommandOutcome {
  const result = crossSpawn.sync(tool, args, {
    cwd: options.cwd,
    stdio: options.inherit ? "inherit" : ["ignore", "ignore", "pipe"],
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      ok: false,
      error: missing
        ? `${tool} is not installed or not on PATH`
        : result.error.message,
    };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    return {
      ok: false,
      error: stderr || `${tool} ${args[0]} exited with ${result.status}`,
    };
  }
  return { ok: true };
}

export type CloneOutcome =
  { ok: true; dir: string; cleanup: () => void } | { ok: false; error: string };

/** Shallow-clone into a fresh temp directory. Caller must run `cleanup`. */
export function cloneShallow(url: string): CloneOutcome {
  const dir = mkdtempSync(join(tmpdir(), "talon-install-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const outcome = runTool("git", ["clone", "--depth=1", url, dir]);
  if (!outcome.ok) {
    cleanup();
    return { ok: false, error: `Clone failed: ${outcome.error}` };
  }
  return { ok: true, dir, cleanup };
}
