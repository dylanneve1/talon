/**
 * VFS — resolver path discipline, file mounts, and the synthetic
 * proc/plugins mounts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vfs } from "../core/vfs/vfs.js";
import { createFileMount } from "../core/vfs/mounts/files.js";
import { createProcMount } from "../core/vfs/mounts/proc.js";
import {
  createPluginsMount,
  type PluginView,
} from "../core/vfs/mounts/plugins.js";
import { VFS_MAX_READ_BYTES } from "../core/vfs/types.js";
import type { TaskRecord } from "../core/tasks/index.js";
import type { PublishedEvent } from "../core/bus/index.js";

let root: string;
let vfs: Vfs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "talon-vfs-"));
  vfs = new Vfs();
  vfs.mount(
    "home",
    createFileMount({ root, description: "workspace", writable: true }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolver", () => {
  it("lists mounts at the root and stats it as a directory", () => {
    const stat = vfs.stat("");
    expect(stat).toMatchObject({ ok: true, value: { kind: "dir" } });

    const listed = vfs.list("");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.name)).toEqual(["home"]);
    expect(listed.value[0]).toMatchObject({ kind: "dir", writable: true });
  });

  it("strips the talon:// scheme and tolerates slash noise", () => {
    writeFileSync(join(root, "a.txt"), "hi");
    expect(vfs.read("talon://home/a.txt")).toEqual({ ok: true, value: "hi" });
    expect(vfs.read("/home//a.txt/")).toEqual({ ok: true, value: "hi" });
  });

  it("rejects traversal segments and backslashes", () => {
    expect(vfs.read("home/../etc/passwd")).toMatchObject({
      ok: false,
      error: "invalid-path",
    });
    expect(vfs.list("home\\x")).toMatchObject({
      ok: false,
      error: "invalid-path",
    });
  });

  it("names the missing mount on unknown roots", () => {
    expect(vfs.list("nope/x")).toMatchObject({
      ok: false,
      error: "not-found",
    });
  });

  it("refuses writes to mounts without a write hook", () => {
    vfs.mount(
      "ro",
      createFileMount({ root, description: "ro", writable: false }),
    );
    expect(vfs.write("ro/a.txt", "x")).toMatchObject({
      ok: false,
      error: "not-writable",
    });
  });

  it("rejects duplicate and invalid mount names", () => {
    expect(() =>
      vfs.mount(
        "home",
        createFileMount({ root, description: "dup", writable: false }),
      ),
    ).toThrow(/already registered/);
    expect(() =>
      vfs.mount(
        "Bad Name",
        createFileMount({ root, description: "bad", writable: false }),
      ),
    ).toThrow(/Invalid mount name/);
  });
});

describe("file mount", () => {
  it("lists directories first with sizes and prefixed paths", () => {
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "a.txt"), "12345");
    writeFileSync(join(root, "notes", "b.md"), "x");

    const listed = vfs.list("home");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.path)).toEqual([
      "home/notes",
      "home/a.txt",
    ]);
    expect(listed.value[1]).toMatchObject({ kind: "file", size: 5 });
  });

  it("stats files with size and mtime", () => {
    writeFileSync(join(root, "a.txt"), "12345");
    const stat = vfs.stat("home/a.txt");
    expect(stat.ok).toBe(true);
    if (!stat.ok) return;
    expect(stat.value).toMatchObject({
      path: "home/a.txt",
      name: "a.txt",
      kind: "file",
      size: 5,
      writable: true,
    });
    expect(stat.value.modifiedAt).toBeGreaterThan(0);
  });

  it("reads UTF-8 text and refuses directories, binaries, oversize", () => {
    writeFileSync(join(root, "ok.txt"), "héllo");
    expect(vfs.read("home/ok.txt")).toEqual({ ok: true, value: "héllo" });

    expect(vfs.read("home")).toMatchObject({
      ok: false,
      error: "is-a-directory",
    });

    writeFileSync(join(root, "bin"), Buffer.from([1, 0, 2]));
    expect(vfs.read("home/bin")).toMatchObject({
      ok: false,
      error: "binary-file",
    });

    writeFileSync(join(root, "big"), "x".repeat(VFS_MAX_READ_BYTES + 1));
    expect(vfs.read("home/big")).toMatchObject({
      ok: false,
      error: "too-large",
    });
  });

  it("writes files, creating parents, and reports the new stat", () => {
    const written = vfs.write("home/deep/nested/file.md", "content");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value).toMatchObject({
      path: "home/deep/nested/file.md",
      kind: "file",
      size: 7,
    });
    expect(vfs.read("home/deep/nested/file.md")).toEqual({
      ok: true,
      value: "content",
    });
  });

  it("refuses to write over a directory", () => {
    mkdirSync(join(root, "dir"));
    expect(vfs.write("home/dir", "x")).toMatchObject({
      ok: false,
      error: "is-a-directory",
    });
  });

  it("treats a missing mount root as an empty directory", () => {
    vfs.mount(
      "ghost",
      createFileMount({
        root: join(root, "does-not-exist"),
        description: "lazy",
        writable: true,
      }),
    );
    expect(vfs.list("ghost")).toEqual({ ok: true, value: [] });
    expect(vfs.stat("ghost")).toMatchObject({
      ok: true,
      value: { kind: "dir" },
    });
  });

  it("rejects escapes even when handed a crafted relative path directly", () => {
    const mount = createFileMount({
      root,
      description: "direct",
      writable: true,
    });
    expect(mount.read("../outside")).toMatchObject({
      ok: false,
      error: "invalid-path",
    });
  });
});

describe("proc mount", () => {
  const task: TaskRecord = {
    id: 7,
    kind: "turn",
    label: "message",
    chatId: "123",
    state: "running",
    killable: false,
    queuedAt: 1000,
    startedAt: 2000,
  };
  const event = {
    type: "task.started",
    task,
    id: 1,
    at: 3000,
  } as PublishedEvent;

  beforeEach(() => {
    vfs.mount(
      "proc",
      createProcMount({ tasks: () => [task], events: () => [event] }),
    );
  });

  it("exposes tasks/ and events at the mount root", () => {
    const listed = vfs.list("proc");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.path)).toEqual([
      "proc/tasks",
      "proc/events",
    ]);
  });

  it("serves one JSON file per task", () => {
    const listed = vfs.list("proc/tasks");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.path)).toEqual(["proc/tasks/7"]);

    const read = vfs.read("proc/tasks/7");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(read.value)).toMatchObject({ id: 7, kind: "turn" });
  });

  it("serves the event ring as JSON Lines with the last event's mtime", () => {
    const read = vfs.read("proc/events");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(read.value.trim())).toMatchObject({
      type: "task.started",
      id: 1,
    });

    const stat = vfs.stat("proc/events");
    expect(stat.ok).toBe(true);
    if (!stat.ok) return;
    expect(stat.value.modifiedAt).toBe(3000);
  });

  it("errors honestly on missing tasks, wrong node kinds, and writes", () => {
    expect(vfs.read("proc/tasks/99")).toMatchObject({
      ok: false,
      error: "not-found",
    });
    expect(vfs.list("proc/events")).toMatchObject({
      ok: false,
      error: "not-a-directory",
    });
    expect(vfs.read("proc/tasks")).toMatchObject({
      ok: false,
      error: "is-a-directory",
    });
    expect(vfs.write("proc/tasks/7", "x")).toMatchObject({
      ok: false,
      error: "not-writable",
    });
  });
});

describe("plugins mount", () => {
  const views: PluginView[] = [
    { name: "github", kind: "module", version: "1.0.0", source: "(built-in)" },
    { name: "fetch", kind: "mcp", source: "npx -y server-fetch" },
  ];

  beforeEach(() => {
    vfs.mount("plugins", createPluginsMount(() => views));
  });

  it("lists one file per registered plugin, sorted", () => {
    const listed = vfs.list("plugins");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.name)).toEqual([
      "fetch",
      "github",
    ]);
  });

  it("reads a plugin as its registry view in JSON", () => {
    const read = vfs.read("plugins/github");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(read.value)).toEqual({
      name: "github",
      kind: "module",
      version: "1.0.0",
      source: "(built-in)",
    });
  });

  it("reports unknown plugins as not-found", () => {
    expect(vfs.read("plugins/nope")).toMatchObject({
      ok: false,
      error: "not-found",
    });
  });
});
