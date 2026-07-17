/**
 * Namespace dir sync (core/vfs/nsdir.ts) — the symlink farm that makes
 * talon:// ↔ ~/.talon/ns a pure prefix substitution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vfs } from "../core/vfs/vfs.js";
import { createFileMount } from "../core/vfs/mounts/files.js";
import { createProcMount } from "../core/vfs/mounts/proc.js";
import { syncNamespaceDir } from "../core/vfs/nsdir.js";

let base: string;
let nsRoot: string;
let vfs: Vfs;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "talon-nsdir-"));
  nsRoot = join(base, "ns");
  vfs = new Vfs();
  vfs.mount(
    "home",
    createFileMount({
      root: join(base, "workspace"),
      description: "ws",
      writable: true,
    }),
  );
  vfs.mount("proc", createProcMount({ tasks: () => [], events: () => [] }));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("syncNamespaceDir", () => {
  it("creates the dir with one symlink per file-backed mount", () => {
    const result = syncNamespaceDir(vfs, nsRoot);
    expect(result.linked).toEqual(["home"]);
    expect(result.pruned).toEqual([]);
    expect(readlinkSync(join(nsRoot, "home"))).toBe(join(base, "workspace"));
    // Targets are created so links are never dangling.
    expect(existsSync(join(base, "workspace"))).toBe(true);
    // Synthetic mounts are NOT materialized — they exist only under FUSE.
    expect(existsSync(join(nsRoot, "proc"))).toBe(false);
  });

  it("is idempotent", () => {
    syncNamespaceDir(vfs, nsRoot);
    const second = syncNamespaceDir(vfs, nsRoot);
    expect(second).toEqual({ linked: [], pruned: [], foreign: [] });
  });

  it("prunes stale symlinks and retargets changed ones", () => {
    mkdirSync(nsRoot, { recursive: true });
    symlinkSync(join(base, "old-target"), join(nsRoot, "gone"));
    symlinkSync(join(base, "old-target"), join(nsRoot, "home"));

    const result = syncNamespaceDir(vfs, nsRoot);
    expect(result.pruned).toEqual(["gone"]);
    expect(result.linked).toEqual(["home"]);
    expect(existsSync(join(nsRoot, "gone"))).toBe(false);
    expect(readlinkSync(join(nsRoot, "home"))).toBe(join(base, "workspace"));
  });

  it("never touches entries that aren't symlinks", () => {
    mkdirSync(nsRoot, { recursive: true });
    writeFileSync(join(nsRoot, "user-file.txt"), "mine");
    mkdirSync(join(nsRoot, "user-dir"));

    const result = syncNamespaceDir(vfs, nsRoot);
    expect(result.foreign.sort()).toEqual(["user-dir", "user-file.txt"]);
    expect(lstatSync(join(nsRoot, "user-file.txt")).isFile()).toBe(true);
    expect(lstatSync(join(nsRoot, "user-dir")).isDirectory()).toBe(true);
  });

  it("lets a foreign entry shadow a mount name without throwing", () => {
    mkdirSync(join(nsRoot, "home"), { recursive: true });
    writeFileSync(join(nsRoot, "home", "keep.txt"), "mine");

    const result = syncNamespaceDir(vfs, nsRoot);
    expect(result.foreign).toEqual(["home"]);
    expect(result.linked).toEqual([]);
    // The user's dir wins; we never link over what we didn't create.
    expect(lstatSync(join(nsRoot, "home")).isDirectory()).toBe(true);
    expect(lstatSync(join(nsRoot, "home")).isSymbolicLink()).toBe(false);
  });
});
