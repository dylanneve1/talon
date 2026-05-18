/**
 * Tests for the shared `expandFsPath` helper. The single thing this
 * has to get right is that `~/` becomes `$HOME/` — every
 * model-supplied path that crosses into `fs.*` or `bot.api.send*`
 * goes through this, and Node's `fs` module does NOT expand tildes
 * itself. A regression here would resurface bugs like ENOENT on
 * `~/.talon/workspace/robot.svg` from `send_file`.
 */
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { resolve, isAbsolute, sep } from "node:path";
import { expandFsPath } from "../util/fs-path.js";

describe("expandFsPath", () => {
  it("expands a bare ~ to the home directory", () => {
    expect(expandFsPath("~")).toBe(homedir());
  });

  it("expands ~/<rel> to $HOME/<rel>", () => {
    expect(expandFsPath("~/.talon/workspace/robot.svg")).toBe(
      resolve(homedir(), ".talon/workspace/robot.svg"),
    );
  });

  it("returns absolute POSIX-style paths unchanged on POSIX, absolute Windows paths unchanged on Windows", () => {
    // `path.isAbsolute` accepts `/foo` as absolute on both platforms
    // (it's the POSIX shape), but `path.resolve` on Windows will
    // prepend the current drive letter — so equality is only safe
    // when we compare against an actually-absolute-on-this-platform
    // input. Build one from the test's own resolved cwd.
    const abs = resolve(process.cwd(), "abs-test-file");
    expect(expandFsPath(abs)).toBe(abs);
  });

  it("resolves relative paths against process.cwd()", () => {
    const out = expandFsPath("relative/file.txt");
    expect(isAbsolute(out)).toBe(true);
    // path.resolve normalises separators to the platform default
    // (backslashes on Windows), so use the resolved comparison value
    // rather than a hard-coded POSIX suffix.
    expect(out).toBe(resolve(process.cwd(), "relative/file.txt"));
  });

  it("returns an empty string unchanged", () => {
    expect(expandFsPath("")).toBe("");
  });

  it("preserves the leading tilde on `~foo` (NOT a home-relative path)", () => {
    // `~foo` is NOT a home-relative path (that would be `~/foo`) —
    // it's a literal filename starting with a tilde. We must NOT
    // expand it as if the user meant `~/foo`. Resolve as relative;
    // the resulting absolute path ends with `<sep>~weird` on both
    // POSIX (sep=`/`) and Windows (sep=`\`). If the expander had
    // mistakenly treated `~weird` as home-relative the path would
    // end with `~weird` directly (without a preceding separator).
    const out = expandFsPath("~weird");
    expect(out.endsWith(`${sep}~weird`)).toBe(true);
  });
});
