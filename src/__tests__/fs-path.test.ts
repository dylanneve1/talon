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
import { resolve, isAbsolute } from "node:path";
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

  it("returns absolute paths unchanged", () => {
    const abs = "/tmp/some/abs/path";
    expect(expandFsPath(abs)).toBe(abs);
  });

  it("resolves relative paths against process.cwd()", () => {
    const out = expandFsPath("relative/file.txt");
    expect(isAbsolute(out)).toBe(true);
    expect(out.endsWith("relative/file.txt")).toBe(true);
  });

  it("returns an empty string unchanged", () => {
    expect(expandFsPath("")).toBe("");
  });

  it("preserves the leading tilde on `~foo` (NOT a home-relative path)", () => {
    // `~foo` is NOT a home-relative path (that would be `~/foo`) —
    // it's a literal filename starting with a tilde. We must NOT
    // expand it as if the user meant `~/foo`; resolve it as a
    // relative path with the tilde intact.
    const out = expandFsPath("~weird");
    expect(out.endsWith("/~weird")).toBe(true);
  });
});
