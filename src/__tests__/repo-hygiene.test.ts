import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Repo hygiene — guards against a class of accident that took the live
 * daemon's exec layer down on 2026-07-18.
 *
 * What happened: a development worktree used a `node_modules` symlink
 * pointing at the main checkout's absolute path to share dependencies.
 * `.gitignore`'s `node_modules/` entry (trailing slash = directories
 * only) does NOT match a symlink, so the symlink was silently staged and
 * shipped inside PR #578. On the deployment host, checking out main then
 * replaced the real `node_modules` directory with a symlink pointing at
 * itself — an ELOOP. That poisoned dir sat first on the daemon's PATH,
 * so execvp aborted on every PATH-searched spawn: bash, ripgrep, every
 * plugin child. Full loss of the exec layer on a live process, only
 * recoverable in-process.
 *
 * These tests pin the two invariants that make the accident impossible:
 * no dependency directories tracked in git, and no committed symlink
 * whose target is an absolute path (absolute targets can never be
 * portable across checkouts — and a self-referential one is a fork bomb
 * for path resolution).
 */

function gitLsFilesStaged(): { mode: string; path: string }[] {
  const out = execFileSync("git", ["ls-files", "-s"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, path] = line.split("\t");
      return { mode: meta.split(" ")[0], path };
    });
}

describe("repo hygiene", () => {
  const entries = gitLsFilesStaged();

  it("tracks no node_modules paths", () => {
    const offenders = entries.filter(
      (e) => e.path === "node_modules" || e.path.includes("node_modules/"),
    );
    expect(offenders).toEqual([]);
  });

  it("tracks no symlinks with absolute targets", () => {
    const symlinks = entries.filter((e) => e.mode === "120000");
    const offenders = symlinks.filter((e) => {
      const target = execFileSync("git", ["cat-file", "-p", `:${e.path}`], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
    });
    expect(offenders).toEqual([]);
  });
});
