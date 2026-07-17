/**
 * talon:// → real path translation (core/vfs/rewrite.ts) — single
 * addresses and whole shell commands, with and without the FUSE layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { join, resolve } from "node:path";
import { Vfs } from "../core/vfs/vfs.js";
import { createFileMount } from "../core/vfs/mounts/files.js";
import { createProcMount } from "../core/vfs/mounts/proc.js";
import {
  resolveNamespacePath,
  rewriteNamespaceRefs,
} from "../core/vfs/rewrite.js";

const NS = "/tmp/fake-ns";
// resolve() so expectations match the mount table's normalized roots on
// every platform (C:\tmp\… on Windows).
const WORKSPACE = resolve("/tmp/fake-workspace");
const SKILLS = resolve("/tmp/fake-skills");

let vfs: Vfs;

beforeEach(() => {
  vfs = new Vfs();
  vfs.mount(
    "home",
    createFileMount({ root: WORKSPACE, description: "ws", writable: true }),
  );
  vfs.mount(
    "skills",
    createFileMount({ root: SKILLS, description: "sk", writable: true }),
  );
  vfs.mount("proc", createProcMount({ tasks: () => [], events: () => [] }));
});

describe("resolveNamespacePath", () => {
  it("maps every address into the mountpoint when FUSE is live", () => {
    expect(resolveNamespacePath("talon://home/a.md", vfs, true, NS)).toEqual({
      ok: true,
      path: `${NS}/home/a.md`,
    });
    expect(resolveNamespacePath("talon://proc/events", vfs, true, NS)).toEqual({
      ok: true,
      path: `${NS}/proc/events`,
    });
    expect(resolveNamespacePath("talon://", vfs, true, NS)).toEqual({
      ok: true,
      path: NS,
    });
  });

  it("maps file mounts to their disk roots when fuseless", () => {
    expect(resolveNamespacePath("talon://home/a.md", vfs, false, NS)).toEqual({
      ok: true,
      path: join(WORKSPACE, "a.md"),
    });
    expect(resolveNamespacePath("talon://home", vfs, false, NS)).toEqual({
      ok: true,
      path: WORKSPACE,
    });
    expect(resolveNamespacePath("talon://", vfs, false, NS)).toEqual({
      ok: true,
      path: NS,
    });
  });

  it("refuses live views when fuseless, naming the cause", () => {
    const resolved = resolveNamespacePath(
      "talon://proc/events",
      vfs,
      false,
      NS,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("FUSE");
    expect(resolved.error).toContain("talon://proc");
  });

  it("propagates resolver errors for unknown mounts and traversal", () => {
    const unknown = resolveNamespacePath("talon://nope/x", vfs, false, NS);
    expect(unknown).toMatchObject({ ok: false });
    const traversal = resolveNamespacePath("talon://home/../x", vfs, false, NS);
    expect(traversal).toMatchObject({ ok: false });
  });
});

describe("rewriteNamespaceRefs", () => {
  it("passes commands without talon:// through untouched", () => {
    const cmd = "ls -la /tmp && echo done";
    expect(rewriteNamespaceRefs(cmd, vfs, false, NS)).toEqual({
      ok: true,
      command: cmd,
      mappings: [],
    });
  });

  it("substitutes every reference via one prefix rule when FUSE is live", () => {
    const rewritten = rewriteNamespaceRefs(
      `cat "talon://proc/events" | jq . && ls talon://home`,
      vfs,
      true,
      NS,
    );
    expect(rewritten).toEqual({
      ok: true,
      command: `cat "${NS}/proc/events" | jq . && ls ${NS}/home`,
      mappings: [`talon:// → ${NS}/`],
    });
  });

  it("substitutes per mount when fuseless, reporting the mappings", () => {
    const rewritten = rewriteNamespaceRefs(
      "grep -r needle talon://skills talon://home/notes",
      vfs,
      false,
      NS,
    );
    expect(rewritten).toEqual({
      ok: true,
      command: `grep -r needle ${SKILLS} ${WORKSPACE}/notes`,
      mappings: [`talon://skills → ${SKILLS}`, `talon://home → ${WORKSPACE}`],
    });
  });

  it("maps the bare namespace root to the symlink farm when fuseless", () => {
    expect(rewriteNamespaceRefs("ls talon://", vfs, false, NS)).toEqual({
      ok: true,
      command: `ls ${NS}/`,
      mappings: [`talon:// → ${NS}/`],
    });
  });

  it("refuses live views when fuseless instead of handing the shell a dead path", () => {
    const rewritten = rewriteNamespaceRefs(
      "cat talon://proc/events",
      vfs,
      false,
      NS,
    );
    expect(rewritten.ok).toBe(false);
    if (rewritten.ok) return;
    expect(rewritten.error).toContain("FUSE");
  });

  it("names unknown mounts with the mount table", () => {
    const rewritten = rewriteNamespaceRefs("ls talon://nope/x", vfs, false, NS);
    expect(rewritten.ok).toBe(false);
    if (rewritten.ok) return;
    expect(rewritten.error).toContain('"nope"');
    expect(rewritten.error).toContain("home");
  });

  it("does not let one mount name shadow another's prefix", () => {
    const rewritten = rewriteNamespaceRefs(
      "ls talon://homework",
      vfs,
      false,
      NS,
    );
    expect(rewritten.ok).toBe(false);
    if (rewritten.ok) return;
    expect(rewritten.error).toContain('"homework"');
  });

  it("corrects near-miss scheme typos instead of guessing", () => {
    const rewritten = rewriteNamespaceRefs(
      "cat talon:/home/a.md",
      vfs,
      false,
      NS,
    );
    expect(rewritten.ok).toBe(false);
    if (rewritten.ok) return;
    expect(rewritten.error).toContain("talon://home");
  });

  it("corrects talon:<mount> only for real mount names", () => {
    const known = rewriteNamespaceRefs("ls talon:home/x", vfs, false, NS);
    expect(known.ok).toBe(false);
    if (known.ok) return;
    expect(known.error).toContain("talon://home");
  });

  it("leaves unrelated talon: tokens alone", () => {
    for (const cmd of [
      `grep "talon:" src/file.ts`,
      "echo talon:2024-review",
      "git log --grep talon:xyz",
    ]) {
      expect(rewriteNamespaceRefs(cmd, vfs, false, NS)).toEqual({
        ok: true,
        command: cmd,
        mappings: [],
      });
    }
  });
});
