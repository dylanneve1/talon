/**
 * `cloneShallow` hardening (#1049): option-looking URLs never reach git,
 * `--` ends option parsing, and the cloned commit is reported so installs
 * can record exactly what they installed.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneShallow, writeInstallRecord } from "../cli/install-sources.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

describe("cloneShallow", () => {
  it("refuses a URL that starts with a dash before running git", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "clone-dash-")), "pwned");
    const result = cloneShallow(`--upload-pack=touch ${marker}`);
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/starts with "-"/),
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports the commit it cloned", () => {
    const repo = mkdtempSync(join(tmpdir(), "clone-src-"));
    git(repo, "init", "-q");
    writeFileSync(join(repo, "SKILL.md"), "# skill\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    const head = git(repo, "rev-parse", "HEAD");

    const result = cloneShallow(`file://${repo}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(result.commit).toBe(head);
      expect(existsSync(join(result.dir, "SKILL.md"))).toBe(true);
    } finally {
      result.cleanup();
    }
    expect(existsSync(result.dir)).toBe(false);
  });
});

describe("writeInstallRecord", () => {
  it("records source, subpath and commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-record-"));
    writeInstallRecord(dir, {
      source: "https://github.com/o/r.git",
      subpath: "plugins/x",
      commit: "a".repeat(40),
    });
    const record = JSON.parse(
      readFileSync(join(dir, ".talon-install.json"), "utf8"),
    );
    expect(record).toMatchObject({
      source: "https://github.com/o/r.git",
      subpath: "plugins/x",
      commit: "a".repeat(40),
    });
    expect(typeof record.installedAt).toBe("string");
  });
});
