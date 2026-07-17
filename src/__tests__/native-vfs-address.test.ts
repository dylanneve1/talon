/**
 * Native tools × talon:// addresses — the OS side of the address
 * grammar. Every path parameter and shell command translates to a real
 * host path (core/vfs/rewrite.ts) and flows through ordinary fs code:
 * disk-backed nodes translate to their real location, live views are
 * refused while the FUSE layer is down (these tests run fuseless), and
 * teleport refuses the combination outright rather than resolving
 * against the wrong filesystem.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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
        if (prop === "ns") return join(workspaceDir, "ns");
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

  it("refuses live views on every surface while the FUSE layer is down", async () => {
    const read = await nativeHandlers.native_read(
      { path: "talon://proc/events" },
      1,
    );
    expect(read.ok).toBe(false);
    expect(read.text).toContain("FUSE");

    const write = await nativeHandlers.native_write(
      { path: "talon://proc/events", content: "x" },
      1,
    );
    expect(write.ok).toBe(false);
    expect(write.text).toContain("FUSE");

    const edit = await nativeHandlers.native_edit(
      { path: "talon://plugins/x", old_string: "a", new_string: "b" },
      1,
    );
    expect(edit.ok).toBe(false);
    expect(edit.text).toContain("FUSE");

    const searched = await nativeHandlers.native_search(
      { pattern: "x", path: "talon://proc" },
      1,
    );
    expect(searched.ok).toBe(false);
    expect(searched.text).toContain("FUSE");
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
  });

  it("expands ~ in path parameters like the shell would", async () => {
    const res = await nativeHandlers.native_read(
      { path: "~/talon-definitely-not-here-4242" },
      1,
    );
    expect(res.ok).toBe(false);
    // The mapping is shown (`~/x → /home/…/x`) and the fs error names the
    // real path, proving the tool operated on the expansion.
    expect(res.text).toContain(
      `→ ${join(homedir(), "talon-definitely-not-here-4242")}`,
    );
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

describe.runIf(process.platform !== "win32")(
  "bash on talon:// references",
  () => {
    it("translates references to real paths and reports the mapping", async () => {
      writeFileSync(join(workspaceDir, "hello.txt"), "from-bash\n");
      const res = await nativeHandlers.native_bash(
        { command: "cat talon://home/hello.txt" },
        1,
      );
      expect(res.ok).toBe(true);
      expect(res.text).toContain(`↪ talon://home → ${workspaceDir}`);
      expect(res.text).toContain("from-bash");
    });

    it("translates references inside quotes and pipelines", async () => {
      const res = await nativeHandlers.native_bash(
        { command: `ls "talon://home" | head -n 50` },
        1,
      );
      expect(res.ok).toBe(true);
      expect(res.text).toContain("hello.txt");
    });

    it("accepts a talon:// cwd", async () => {
      const res = await nativeHandlers.native_bash(
        { command: "pwd", cwd: "talon://home" },
        1,
      );
      expect(res.ok).toBe(true);
      expect(res.text).toContain(workspaceDir);
    });

    it("refuses live views fuseless, with the reason", async () => {
      const res = await nativeHandlers.native_bash(
        { command: "cat talon://proc/events" },
        1,
      );
      expect(res.ok).toBe(false);
      expect(res.text).toContain("FUSE");
    });

    it("corrects near-miss scheme typos", async () => {
      const res = await nativeHandlers.native_bash(
        { command: "cat talon:/home/hello.txt" },
        1,
      );
      expect(res.ok).toBe(false);
      expect(res.text).toContain("talon://home");
    });

    it("names unknown mounts instead of handing the shell a dead path", async () => {
      const res = await nativeHandlers.native_bash(
        { command: "ls talon://bogus" },
        1,
      );
      expect(res.ok).toBe(false);
      expect(res.text).toContain('"bogus"');
    });

    it("refuses namespace references while teleported", async () => {
      await setTeleport(9, "device-1", "Pixel");
      try {
        const res = await nativeHandlers.native_bash(
          { command: "ls talon://home" },
          9,
        );
        expect(res.ok).toBe(false);
        expect(res.text).toContain("teleport_back");
      } finally {
        await clearTeleport(9);
        resetTeleportCache();
      }
    });
  },
);
