import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runSelfUpdate,
  getRepoRoot,
  type CommandRunner,
} from "../core/update/self-update.js";

/**
 * Build a runner that replies based on the command + args. `headSeq`
 * supplies successive `git rev-parse HEAD` results (before, after).
 */
function makeRunner(opts: {
  headSeq?: string[];
  fail?: (cmd: string, args: readonly string[]) => string | null;
  calls?: string[][];
}): CommandRunner {
  const heads = [...(opts.headSeq ?? ["aaaaaaaaaaaa", "aaaaaaaaaaaa"])];
  return async (cmd, args) => {
    opts.calls?.push([cmd, ...args]);
    const failOut = opts.fail?.(cmd, args);
    if (failOut) return { ok: false, output: failOut };
    if (cmd === "git" && args[0] === "rev-parse") {
      return { ok: true, output: heads.shift() ?? "aaaaaaaaaaaa" };
    }
    return { ok: true, output: "ok" };
  };
}

const ROOT = "/repo";

describe("runSelfUpdate", () => {
  it("reports no change and skips install when HEAD does not move", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      runner: makeRunner({ headSeq: ["abc123abc123", "abc123abc123"], calls }),
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.before).toBe("abc123abc123");
    // npm install must NOT have run.
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("resets, installs, runs setup, and reports change on update", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      remote: "upstream",
      branch: "dev",
      setup: ["npm run build"],
      runner: makeRunner({ headSeq: ["aaa111aaa111", "bbb222bbb222"], calls }),
    });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.before).toBe("aaa111aaa111");
    expect(res.after).toBe("bbb222bbb222");
    // Custom remote/branch threaded into fetch + reset.
    expect(calls).toContainEqual(["git", "fetch", "upstream", "dev"]);
    expect(calls).toContainEqual(["git", "reset", "--hard", "upstream/dev"]);
    expect(calls).toContainEqual(["git", "clean", "-fd"]);
    expect(calls).toContainEqual(["npm", "install"]);
    expect(calls).toContainEqual(["sh", "-c", "npm run build"]);
  });

  it("defaults remote/branch to origin/main", async () => {
    const calls: string[][] = [];
    await runSelfUpdate({
      repoRoot: ROOT,
      runner: makeRunner({ headSeq: ["a1", "b2"], calls }),
    });
    expect(calls).toContainEqual(["git", "fetch", "origin", "main"]);
    expect(calls).toContainEqual(["git", "reset", "--hard", "origin/main"]);
  });

  it("stops before install when the reset fails", async () => {
    const calls: string[][] = [];
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      runner: makeRunner({
        headSeq: ["a1", "b2"],
        calls,
        fail: (cmd, args) =>
          cmd === "git" && args[0] === "reset" ? "fatal: reset failed" : null,
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/reset --hard/i);
    expect(calls.some((c) => c[0] === "npm")).toBe(false);
  });

  it("fails when npm install fails (after a real change)", async () => {
    const res = await runSelfUpdate({
      repoRoot: ROOT,
      runner: makeRunner({
        headSeq: ["a1", "b2"],
        fail: (cmd) => (cmd === "npm" ? "ENOSPC" : null),
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/npm install failed/i);
    expect(res.changed).toBe(true);
  });
});

describe("getRepoRoot", () => {
  it("finds a dir containing both .git and package.json", () => {
    const base = mkdtempSync(join(tmpdir(), "talon-repo-"));
    try {
      mkdirSync(join(base, ".git"));
      writeFileSync(join(base, "package.json"), "{}");
      const nested = join(base, "src", "core", "update");
      mkdirSync(nested, { recursive: true });
      expect(getRepoRoot(nested)).toBe(base);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns null when there is no git checkout above", () => {
    const base = mkdtempSync(join(tmpdir(), "talon-nogit-"));
    try {
      const nested = join(base, "a", "b");
      mkdirSync(nested, { recursive: true });
      // No .git anywhere up to filesystem root from this temp dir.
      const found = getRepoRoot(nested);
      // Either null, or (paranoia) not inside our temp tree.
      expect(found === null || !found.startsWith(base)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
