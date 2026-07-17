/**
 * talon-fusefs LIVE — mounts the real addon at a temp mountpoint and
 * exercises the kernel round-trip: symlink serving, live synthetic
 * reads (in-process async AND from a child process), EROFS on
 * mutation, errno mapping, and clean unmount back to the symlink farm.
 *
 * Self-skips unless the host can actually mount: Linux + /dev/fuse +
 * fusermount + the built addon (bin/talon-fusefs.node or
 * TALON_FUSEFS_NODE). CI builds the addon before running this file.
 *
 * DEADLOCK RULE: everything in-process here is async fs — a sync call
 * under the mountpoint would block the very event loop that answers
 * the FUSE bridge (see core/vfs/fusefs.ts).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFile as execFileCb, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { Vfs } from "../core/vfs/vfs.js";
import { createFileMount } from "../core/vfs/mounts/files.js";
import { createProcMount } from "../core/vfs/mounts/proc.js";
import {
  isNamespaceFsMounted,
  mountNamespaceFs,
  unmountNamespaceFs,
} from "../core/vfs/fusefs.js";
import { nativeFuseFs } from "../native/fusefs.js";
import type { TaskRecord } from "../core/tasks/index.js";
import type { PublishedEvent } from "../core/bus/index.js";

const execFile = promisify(execFileCb);

function fusermountPresent(): boolean {
  return ["fusermount3", "fusermount"].some(
    (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0,
  );
}

const canMount =
  process.platform === "linux" &&
  existsSync("/dev/fuse") &&
  fusermountPresent() &&
  nativeFuseFs() !== null;

const task: TaskRecord = {
  id: 3,
  kind: "turn",
  label: "message",
  chatId: "1",
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

describe.runIf(canMount)("talon-fusefs live mount", () => {
  let base: string;
  let nsRoot: string;
  let workspace: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "talon-fuse-live-"));
    nsRoot = join(base, "ns");
    workspace = join(base, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "hello.txt"), "through-the-symlink\n");

    const vfs = new Vfs();
    vfs.mount(
      "home",
      createFileMount({ root: workspace, description: "ws", writable: true }),
    );
    vfs.mount(
      "proc",
      createProcMount({ tasks: () => [task], events: () => [event] }),
    );

    const status = await mountNamespaceFs({ mode: "auto", vfs, nsRoot });
    expect(status).toEqual({ mounted: true });
  }, 30_000);

  afterAll(async () => {
    await unmountNamespaceFs();
    rmSync(base, { recursive: true, force: true });
  });

  it("lists the full namespace at the mountpoint", async () => {
    expect((await readdir(nsRoot)).sort()).toEqual(["home", "proc"]);
  });

  it("serves file mounts as symlinks the kernel follows", async () => {
    expect((await lstat(join(nsRoot, "home"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(nsRoot, "home"))).toBe(workspace);
    // Read THROUGH the mountpoint — resolves to the real file natively.
    expect(await readFile(join(nsRoot, "home", "hello.txt"), "utf8")).toBe(
      "through-the-symlink\n",
    );
  });

  it("serves live synthetic state to this process (async)", async () => {
    expect((await readdir(join(nsRoot, "proc"))).sort()).toEqual([
      "events",
      "tasks",
    ]);
    const record = JSON.parse(
      await readFile(join(nsRoot, "proc", "tasks", "3"), "utf8"),
    );
    expect(record).toMatchObject({ id: 3, kind: "turn", state: "running" });
  });

  it("serves live synthetic state to external processes", async () => {
    const ls = await execFile("ls", [join(nsRoot, "proc")]);
    expect(ls.stdout).toContain("tasks");
    expect(ls.stdout).toContain("events");

    const cat = await execFile("cat", [join(nsRoot, "proc", "events")]);
    expect(JSON.parse(cat.stdout.trim())).toMatchObject({
      type: "task.started",
      id: 1,
    });
  });

  it("carries live mtimes on synthetic stats", async () => {
    const events = await stat(join(nsRoot, "proc", "events"));
    expect(events.mtimeMs).toBe(3000);
  });

  it("answers mutation with EROFS and misses with ENOENT", async () => {
    await expect(
      writeFile(join(nsRoot, "proc", "scribble"), "x"),
    ).rejects.toMatchObject({ code: "EROFS" });
    await expect(
      readFile(join(nsRoot, "proc", "tasks", "99")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(nsRoot, "proc", "nonsense")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("unmounts back to the plain symlink farm", async () => {
    await unmountNamespaceFs();
    expect(isNamespaceFsMounted()).toBe(false);
    // The farm underneath is what remains: file mounts only.
    expect(await readdir(nsRoot)).toEqual(["home"]);
    expect(existsSync(join(nsRoot, "proc"))).toBe(false);
  });
});

describe.runIf(!canMount)("talon-fusefs live mount (skipped)", () => {
  it("host cannot mount — degradation is covered by vfs-fusefs.test.ts", () => {
    // The fusefs CI job sets this after building the addon: a silent
    // skip there would report green without ever mounting.
    expect(
      process.env.TALON_REQUIRE_FUSE_LIVE,
      "TALON_REQUIRE_FUSE_LIVE is set but this host cannot mount — the live suite silently skipped",
    ).not.toBe("1");
    expect(canMount).toBe(false);
  });
});
