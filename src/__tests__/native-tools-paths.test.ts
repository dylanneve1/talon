/**
 * Native tools × path parameters — the address contract after the
 * talon:// scheme removal.
 *
 * The namespace has no tool-facing address scheme: its nodes are reached
 * by their real paths (~/.talon/ns/…, kept real by the symlink farm and
 * the FUSE layer). Native tools therefore do exactly two things to a path
 * parameter — expand a leading `~` (local runs only) and otherwise pass
 * it through untouched. A `talon://…` string is NOT special-cased; it is
 * an ordinary (bogus) path like any other, proving no translation seam
 * remains.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { nativeHandlers } from "../core/engine/gateway-actions/native.js";

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "talon-native-paths-"));
  process.env.TALON_TELEPORT_STATE_FILE = join(workdir, "teleport.json");
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("native tools path handling", () => {
  it("reads, writes and edits through a real absolute path", async () => {
    const p = join(workdir, "sub", "note.md");
    const written = await nativeHandlers.native_write(
      { path: p, content: "v1" },
      1,
    );
    expect(written.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("v1");

    const edited = await nativeHandlers.native_edit(
      { path: p, old_string: "v1", new_string: "v2" },
      1,
    );
    expect(edited.ok).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("v2");

    const read = await nativeHandlers.native_read({ path: p }, 1);
    expect(read.ok).toBe(true);
    expect(read.text).toContain("v2");
  });

  it("expands a leading ~ like the shell would", async () => {
    const res = await nativeHandlers.native_read(
      { path: "~/talon-definitely-not-here-4242" },
      1,
    );
    expect(res.ok).toBe(false);
    // The fs error names the expanded real path, proving `~` was resolved.
    expect(res.text).toContain(
      join(homedir(), "talon-definitely-not-here-4242"),
    );
  });

  it("does not translate a talon:// string — it is an ordinary bogus path", async () => {
    const res = await nativeHandlers.native_read(
      { path: "talon://home/whatever" },
      1,
    );
    expect(res.ok).toBe(false);
    // No scheme resolution: the literal string reaches the fs layer verbatim
    // (and fails), rather than being rewritten to a workspace path.
    expect(res.text).toContain("talon://home/whatever");
  });

  it("globs and searches under a real directory root", async () => {
    writeFileSync(join(workdir, "findme.ts"), "const needle = 1;\n");
    const globbed = await nativeHandlers.native_glob(
      { pattern: "findme.ts", path: workdir },
      1,
    );
    expect(globbed.ok).toBe(true);
    expect(globbed.text).toContain("findme.ts");

    const searched = await nativeHandlers.native_search(
      { pattern: "needle", path: workdir },
      1,
    );
    expect(searched.ok).toBe(true);
    expect(searched.text).toContain("findme.ts");
  });
});
