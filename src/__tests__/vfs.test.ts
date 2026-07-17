/**
 * VFS — resolver address grammar, file mounts, and the synthetic
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
    expect(listed.value[0]).toMatchObject({
      kind: "dir",
      writable: true,
      osPath: root,
    });
  });

  it("resolves talon:// addresses and tolerates slash noise", () => {
    writeFileSync(join(root, "a.txt"), "hi");
    expect(vfs.read("talon://home/a.txt")).toEqual({ ok: true, value: "hi" });
    expect(vfs.read("talon://home//a.txt/")).toEqual({ ok: true, value: "hi" });
    expect(vfs.list("talon://")).toMatchObject({ ok: true });
  });

  it("refuses the old bare mount-relative spelling with the correction", () => {
    writeFileSync(join(root, "a.txt"), "hi");
    expect(vfs.read("home/a.txt")).toMatchObject({
      ok: false,
      error: "invalid-path",
      detail: expect.stringContaining("talon://"),
    });
  });

  it("corrects near-miss scheme spellings", () => {
    expect(vfs.read("talon:/home/a.txt")).toMatchObject({
      ok: false,
      error: "invalid-path",
      detail: expect.stringContaining('"talon://home/a.txt"'),
    });
    expect(vfs.read("talon:home")).toMatchObject({
      ok: false,
      error: "invalid-path",
      detail: expect.stringContaining('"talon://home"'),
    });
  });

  it("rejects traversal segments and backslashes", () => {
    expect(vfs.read("talon://home/../etc/passwd")).toMatchObject({
      ok: false,
      error: "invalid-path",
    });
    expect(vfs.list("talon://home\\x")).toMatchObject({
      ok: false,
      error: "invalid-path",
    });
  });

  it("names the missing mount on unknown roots", () => {
    expect(vfs.list("talon://nope/x")).toMatchObject({
      ok: false,
      error: "not-found",
    });
  });

  it("refuses writes to mounts without a write hook", () => {
    vfs.mount(
      "ro",
      createFileMount({ root, description: "ro", writable: false }),
    );
    expect(vfs.write("talon://ro/a.txt", "x")).toMatchObject({
      ok: false,
      error: "not-writable",
    });
  });

  it("addresses the namespace root as bare separators", () => {
    const listed = vfs.list("/");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.name)).toEqual(["home"]);
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

  it("describes the mount table with disk roots", () => {
    vfs.mount(
      "plugins",
      createPluginsMount(() => []),
    );
    expect(vfs.describeMounts()).toEqual([
      {
        name: "home",
        description: "workspace",
        writable: true,
        osRoot: root,
      },
      {
        name: "plugins",
        description:
          "Loaded plugins and registered MCP servers (registry view)",
        writable: false,
      },
    ]);
  });
});

describe("address grammar — OS-absolute spellings", () => {
  it("routes an OS path inside a mount root to the same node", () => {
    writeFileSync(join(root, "a.txt"), "hi");
    expect(vfs.read(join(root, "a.txt"))).toEqual({ ok: true, value: "hi" });

    const stat = vfs.stat(join(root, "a.txt"));
    expect(stat).toMatchObject({
      ok: true,
      value: { path: "home/a.txt", kind: "file" },
    });

    const written = vfs.write(join(root, "notes", "new.md"), "content");
    expect(written).toMatchObject({
      ok: true,
      value: { path: "home/notes/new.md" },
    });
    expect(vfs.read("talon://home/notes/new.md")).toEqual({
      ok: true,
      value: "content",
    });
  });

  it("routes the mount root's own OS path to the mount", () => {
    expect(vfs.stat(root)).toMatchObject({
      ok: true,
      value: { path: "home", kind: "dir" },
    });
  });

  it("prefers the most specific mount for nested disk roots", () => {
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "b.md"), "nested");
    vfs.mount(
      "sub",
      createFileMount({
        root: join(root, "notes"),
        description: "nested",
        writable: true,
      }),
    );
    expect(vfs.stat(join(root, "notes", "b.md"))).toMatchObject({
      ok: true,
      value: { path: "sub/b.md" },
    });
    // Outside the nested root, the outer mount still claims the path.
    writeFileSync(join(root, "top.txt"), "t");
    expect(vfs.stat(join(root, "top.txt"))).toMatchObject({
      ok: true,
      value: { path: "home/top.txt" },
    });
  });

  it("refuses OS paths outside every mount, naming the disk roots", () => {
    const outside = vfs.read(`${root}-elsewhere${join("/", "x.txt")}`);
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.error).toBe("not-found");
    expect(outside.detail).toContain("Mounts on disk");
    expect(outside.detail).toContain(root);
  });

  it("suggests the namespace respelling when the OS path shadows a mount", () => {
    const result = vfs.read("/home/nope.txt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not-found");
    expect(result.detail).toContain('did you mean "talon://home/nope.txt"');
  });

  it("refuses relative and ~ spellings with the address grammar", () => {
    for (const path of ["~/notes.md", "notes.md", "./notes.md"]) {
      expect(vfs.read(path)).toMatchObject({
        ok: false,
        error: "invalid-path",
        detail: expect.stringContaining("talon://"),
      });
    }
  });

  it("never routes a foreign drive spelling against this host", () => {
    const result = vfs.read("C:/definitely/not/mounted.txt");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not-found");
  });
});

describe("locate — namespace → disk", () => {
  it("maps file-mount addresses to absolute paths, existing or not", () => {
    expect(vfs.locate("talon://home/a.txt")).toEqual({
      ok: true,
      value: join(root, "a.txt"),
    });
    expect(vfs.locate("talon://home/deep/unborn.md")).toEqual({
      ok: true,
      value: join(root, "deep", "unborn.md"),
    });
    expect(vfs.locate("talon://home")).toEqual({ ok: true, value: root });
  });

  it("answers undefined for synthetic nodes and the root", () => {
    vfs.mount(
      "plugins",
      createPluginsMount(() => []),
    );
    expect(vfs.locate("talon://plugins/x")).toEqual({
      ok: true,
      value: undefined,
    });
    expect(vfs.locate("")).toEqual({ ok: true, value: undefined });
  });

  it("propagates address errors", () => {
    expect(vfs.locate("talon://home/../etc")).toMatchObject({
      ok: false,
      error: "invalid-path",
    });
    expect(vfs.locate("talon://nope/x")).toMatchObject({
      ok: false,
      error: "not-found",
    });
  });
});

describe("file mount", () => {
  it("lists directories first with sizes and prefixed paths", () => {
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "a.txt"), "12345");
    writeFileSync(join(root, "notes", "b.md"), "x");

    const listed = vfs.list("talon://home");
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
    const stat = vfs.stat("talon://home/a.txt");
    expect(stat.ok).toBe(true);
    if (!stat.ok) return;
    expect(stat.value).toMatchObject({
      path: "home/a.txt",
      name: "a.txt",
      kind: "file",
      size: 5,
      writable: true,
      osPath: join(root, "a.txt"),
    });
    expect(stat.value.modifiedAt).toBeGreaterThan(0);
  });

  it("reads UTF-8 text and refuses directories, binaries, oversize", () => {
    writeFileSync(join(root, "ok.txt"), "héllo");
    expect(vfs.read("talon://home/ok.txt")).toEqual({
      ok: true,
      value: "héllo",
    });

    expect(vfs.read("talon://home")).toMatchObject({
      ok: false,
      error: "is-a-directory",
    });

    writeFileSync(join(root, "bin"), Buffer.from([1, 0, 2]));
    expect(vfs.read("talon://home/bin")).toMatchObject({
      ok: false,
      error: "binary-file",
    });

    writeFileSync(join(root, "big"), "x".repeat(VFS_MAX_READ_BYTES + 1));
    expect(vfs.read("talon://home/big")).toMatchObject({
      ok: false,
      error: "too-large",
      // The disk location is the escape hatch: OS tools can read what the
      // namespace's context-sized cap refuses.
      detail: expect.stringContaining(join(root, "big")),
    });
  });

  it("writes files, creating parents, and reports the new stat", () => {
    const written = vfs.write("talon://home/deep/nested/file.md", "content");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value).toMatchObject({
      path: "home/deep/nested/file.md",
      kind: "file",
      size: 7,
    });
    expect(vfs.read("talon://home/deep/nested/file.md")).toEqual({
      ok: true,
      value: "content",
    });
  });

  it("refuses to write over a directory", () => {
    mkdirSync(join(root, "dir"));
    expect(vfs.write("talon://home/dir", "x")).toMatchObject({
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
    expect(vfs.list("talon://ghost")).toEqual({ ok: true, value: [] });
    expect(vfs.stat("talon://ghost")).toMatchObject({
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
    const listed = vfs.list("talon://proc");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.path)).toEqual([
      "proc/tasks",
      "proc/events",
    ]);
  });

  it("serves one JSON file per task", () => {
    const listed = vfs.list("talon://proc/tasks");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.path)).toEqual(["proc/tasks/7"]);

    const read = vfs.read("talon://proc/tasks/7");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(read.value)).toMatchObject({ id: 7, kind: "turn" });
  });

  it("serves the event ring as JSON Lines with the last event's mtime", () => {
    const read = vfs.read("talon://proc/events");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(JSON.parse(read.value.trim())).toMatchObject({
      type: "task.started",
      id: 1,
    });

    const stat = vfs.stat("talon://proc/events");
    expect(stat.ok).toBe(true);
    if (!stat.ok) return;
    expect(stat.value.modifiedAt).toBe(3000);
  });

  it("errors honestly on missing tasks, wrong node kinds, and writes", () => {
    expect(vfs.read("talon://proc/tasks/99")).toMatchObject({
      ok: false,
      error: "not-found",
    });
    expect(vfs.list("talon://proc/events")).toMatchObject({
      ok: false,
      error: "not-a-directory",
    });
    expect(vfs.read("talon://proc/tasks")).toMatchObject({
      ok: false,
      error: "is-a-directory",
    });
    expect(vfs.write("talon://proc/tasks/7", "x")).toMatchObject({
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
    vfs.mount(
      "plugins",
      createPluginsMount(() => views),
    );
  });

  it("lists one file per registered plugin, sorted", () => {
    const listed = vfs.list("talon://plugins");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((entry) => entry.name)).toEqual([
      "fetch",
      "github",
    ]);
  });

  it("reads a plugin as its registry view in JSON", () => {
    const read = vfs.read("talon://plugins/github");
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
    expect(vfs.read("talon://plugins/nope")).toMatchObject({
      ok: false,
      error: "not-found",
    });
  });
});
