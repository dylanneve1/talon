/**
 * Native fs tools × talon:// addresses — the OS side of the address
 * grammar. read/write/edit/glob/search accept namespace addresses:
 * disk-backed nodes translate to their real location, synthetic nodes are
 * served (reads) or refused (mutation), and teleport refuses the
 * combination outright rather than resolving against the wrong filesystem.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

let workspaceDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    dirs: new Proxy(real.dirs, {
      get(target, prop: string) {
        if (prop === "workspace") return workspaceDir;
        if (prop === "skills") return join(workspaceDir, "skills");
        if (prop === "scripts") return join(workspaceDir, "scripts");
        if (prop === "logs") return join(workspaceDir, "logs");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { nativeHandlers } from "../core/engine/gateway-actions/native.js";
import {
  clearTeleport,
  resetTeleportCache,
  setTeleport,
} from "../core/mesh/teleport.js";

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-native-vfs-"));
  process.env.TALON_TELEPORT_STATE_FILE = join(workspaceDir, "teleport.json");
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("native tools on talon:// addresses", () => {
  it("reads a disk-backed address through its real location", async () => {
    mkdirSync(join(workspaceDir, "notes"), { recursive: true });
    writeFileSync(join(workspaceDir, "notes", "a.md"), "alpha\nbeta");
    const res = await nativeHandlers.native_read(
      { path: "talon://home/notes/a.md" },
      1,
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain(
      `talon://home/notes/a.md → ${join(workspaceDir, "notes", "a.md")}`,
    );
    expect(res.text).toContain("alpha");
  });

  it("writes and edits through the namespace address", async () => {
    const written = await nativeHandlers.native_write(
      { path: "talon://home/deep/new.md", content: "v1" },
      1,
    );
    expect(written.ok).toBe(true);
    expect(readFileSync(join(workspaceDir, "deep", "new.md"), "utf8")).toBe(
      "v1",
    );

    const edited = await nativeHandlers.native_edit(
      { path: "talon://home/deep/new.md", old_string: "v1", new_string: "v2" },
      1,
    );
    expect(edited.ok).toBe(true);
    expect(readFileSync(join(workspaceDir, "deep", "new.md"), "utf8")).toBe(
      "v2",
    );
  });

  it("serves synthetic reads from the namespace and refuses mutation", async () => {
    const read = await nativeHandlers.native_read(
      { path: "talon://proc/events" },
      1,
    );
    expect(read.ok).toBe(true);
    expect(read.text).toContain("talon://proc/events [local]");

    const write = await nativeHandlers.native_write(
      { path: "talon://proc/events", content: "x" },
      1,
    );
    expect(write.ok).toBe(false);
    expect(write.text).toContain("synthetic");

    const edit = await nativeHandlers.native_edit(
      { path: "talon://plugins/x", old_string: "a", new_string: "b" },
      1,
    );
    expect(edit.ok).toBe(false);
    expect(edit.text).toContain("synthetic");
  });

  it("surfaces address errors from the resolver", async () => {
    const res = await nativeHandlers.native_read({ path: "talon://nope/x" }, 1);
    expect(res.ok).toBe(false);
    expect(res.text).toContain("not-found");
  });

  it("globs and searches under a namespace root", async () => {
    writeFileSync(join(workspaceDir, "findme.ts"), "const needle = 1;\n");
    const globbed = await nativeHandlers.native_glob(
      { pattern: "findme.ts", path: "talon://home" },
      1,
    );
    expect(globbed.ok).toBe(true);
    expect(globbed.text).toContain("findme.ts");

    const searched = await nativeHandlers.native_search(
      { pattern: "needle", path: "talon://home" },
      1,
    );
    expect(searched.ok).toBe(true);
    expect(searched.text).toContain("findme.ts");

    const synthetic = await nativeHandlers.native_search(
      { pattern: "x", path: "talon://proc" },
      1,
    );
    expect(synthetic.ok).toBe(false);
    expect(synthetic.text).toContain("vfs_list");
  });

  it("refuses namespace addresses while teleported", async () => {
    await setTeleport(7, "device-1", "Pixel");
    try {
      const res = await nativeHandlers.native_read(
        { path: "talon://home/x" },
        7,
      );
      expect(res.ok).toBe(false);
      expect(res.text).toContain("teleport_back");
    } finally {
      await clearTeleport(7);
      resetTeleportCache();
    }
  });
});
