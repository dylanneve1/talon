/**
 * FUSE layer lifecycle (core/vfs/fusefs.ts) — the bridge protocol and,
 * above all, the graceful cut between fuse-on and fuse-off: a host
 * where FUSE is enabled but unsupported (no addon, failing mount,
 * unhealthy mount) must land fuseless with the symlink farm intact and
 * a recorded reason, never an error.
 *
 * A real mount is exercised separately in fusefs-live.test.ts (gated on
 * the addon + /dev/fuse being present).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  _checkNamespaceFsHealthForTesting,
  _reconnectAttemptsForTesting,
  isNamespaceFsMounted,
  mountNamespaceFs,
  namespaceFsStatus,
  serveNamespaceRequest,
  unmountNamespaceFs,
} from "../core/vfs/fusefs.js";
import type { NativeFuseFs } from "../native/fusefs.js";
import type { TaskRecord } from "../core/tasks/index.js";

let base: string;
let nsRoot: string;
let vfs: Vfs;

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

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "talon-fusefs-"));
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
  vfs.mount("proc", createProcMount({ tasks: () => [task], events: () => [] }));
});

afterEach(async () => {
  await unmountNamespaceFs();
  rmSync(base, { recursive: true, force: true });
});

// ── Bridge protocol ──────────────────────────────────────────────────────────

describe("serveNamespaceRequest", () => {
  it("serves stat / list / read for synthetic nodes", () => {
    expect(
      JSON.parse(serveNamespaceRequest(vfs, "stat", "proc")),
    ).toMatchObject({ ok: true, kind: "dir" });
    expect(
      JSON.parse(serveNamespaceRequest(vfs, "list", "proc/tasks")),
    ).toEqual({ ok: true, entries: [{ name: "3", kind: "file" }] });

    const read = JSON.parse(serveNamespaceRequest(vfs, "read", "proc/tasks/3"));
    expect(read.ok).toBe(true);
    const content = Buffer.from(read.data, "base64").toString("utf-8");
    expect(JSON.parse(content)).toMatchObject({ id: 3, kind: "turn" });
  });

  it("answers errno replies, never throws", () => {
    expect(
      JSON.parse(serveNamespaceRequest(vfs, "stat", "proc/tasks/99")),
    ).toEqual({ ok: false, errno: "ENOENT" });
    expect(JSON.parse(serveNamespaceRequest(vfs, "read", "proc"))).toEqual({
      ok: false,
      errno: "EISDIR",
    });
    expect(
      JSON.parse(serveNamespaceRequest(vfs, "list", "proc/tasks/3")),
    ).toEqual({ ok: false, errno: "ENOTDIR" });
    expect(JSON.parse(serveNamespaceRequest(vfs, "bogus-op", "proc"))).toEqual({
      ok: false,
      errno: "EIO",
    });
  });
});

// ── Graceful degradation — FUSE wanted but not possible ──────────────────────

describe("mountNamespaceFs degradation", () => {
  it('stays down with fuse: "off", with the farm synced', async () => {
    const status = await mountNamespaceFs({ mode: "off", vfs, nsRoot });
    expect(status.mounted).toBe(false);
    expect(status.reason).toContain('fuse: "off"');
    expect(existsSync(join(nsRoot, "home"))).toBe(true);
    expect(isNamespaceFsMounted()).toBe(false);
  });

  it("falls back cleanly when the addon is unavailable", async () => {
    const status = await mountNamespaceFs({
      mode: "auto",
      vfs,
      nsRoot,
      addon: null,
    });
    expect(status.mounted).toBe(false);
    if (process.platform === "linux" && existsSync("/dev/fuse")) {
      expect(status.reason).toContain("addon not available");
    }
    // Either way the fuseless namespace is intact.
    expect(existsSync(join(nsRoot, "home"))).toBe(true);
  });

  it("falls back when the addon's mount throws", async () => {
    const addon = fakeAddon({
      mount: () => {
        throw new Error("fusermount3 not found");
      },
    });
    const status = await mountNamespaceFs({ mode: "auto", vfs, nsRoot, addon });
    expect(status.mounted).toBe(false);
    if (process.platform === "linux" && existsSync("/dev/fuse")) {
      expect(status.reason).toContain("fusermount3 not found");
    }
    expect(existsSync(join(nsRoot, "home"))).toBe(true);
  });

  it("rolls a mount back when the sanity check can't see live views", async () => {
    // The fake "mounts" without making proc/ appear — exactly what a
    // half-broken FUSE setup looks like from the outside.
    const addon = fakeAddon({});
    const status = await mountNamespaceFs({ mode: "auto", vfs, nsRoot, addon });
    expect(status.mounted).toBe(false);
    if (process.platform === "linux" && existsSync("/dev/fuse")) {
      expect(status.reason).toContain("sanity check failed");
      expect(addon.unmountCalls).toBe(1);
    }
    expect(existsSync(join(nsRoot, "home"))).toBe(true);
    expect(isNamespaceFsMounted()).toBe(false);
  });
});

// ── Lifecycle with a healthy (faked) mount ───────────────────────────────────

describe.runIf(process.platform === "linux" && existsSync("/dev/fuse"))(
  "mountNamespaceFs lifecycle",
  () => {
    it("mounts, advertises, and unmounts", async () => {
      const addon = fakeAddon({
        mount: (mountpoint, _symlinks, synthetic) => {
          // Simulate the kernel view: synthetic mounts appear as dirs.
          for (const name of synthetic) {
            mkdirSync(join(mountpoint, name), { recursive: true });
          }
        },
      });
      const status = await mountNamespaceFs({
        mode: "auto",
        vfs,
        nsRoot,
        addon,
      });
      expect(status).toEqual({ mounted: true });
      expect(isNamespaceFsMounted()).toBe(true);
      expect(addon.mountCalls).toHaveLength(1);
      expect(addon.mountCalls[0]).toMatchObject({
        mountpoint: nsRoot,
        symlinks: [{ name: "home", target: join(base, "workspace") }],
        synthetic: ["proc"],
      });

      await unmountNamespaceFs();
      expect(isNamespaceFsMounted()).toBe(false);
      expect(namespaceFsStatus().reason).toBe("unmounted");
      expect(addon.unmountCalls).toBe(1);

      // Idempotent.
      await unmountNamespaceFs();
      expect(addon.unmountCalls).toBe(1);
    });
  },
);

// ── Runtime resilience — the health watchdog ─────────────────────────────────
//
// A `bin/*.node` rebuilt under the running daemon, or a wedged
// mountpoint, must never take the daemon down: the watchdog degrades to
// fuseless (farm intact) and then reconnects, bounded. Same linux+fuse
// gate as the lifecycle suite — a real mount only happens there.

describe.runIf(process.platform === "linux" && existsSync("/dev/fuse"))(
  "namespace fs health watchdog",
  () => {
    it("degrades to fuseless and reconnects when the mount goes unhealthy", async () => {
      // Mount hook re-creates the synthetic dirs every time, so both the
      // initial mount and the reconnect pass their sanity checks.
      const addon = fakeAddon({
        mount: (mountpoint, _symlinks, synthetic) => {
          for (const name of synthetic) {
            mkdirSync(join(mountpoint, name), { recursive: true });
          }
        },
      });
      expect(
        (await mountNamespaceFs({ mode: "auto", vfs, nsRoot, addon })).mounted,
      ).toBe(true);

      // The mount stops serving live views — proc/ vanishes.
      rmSync(join(nsRoot, "proc"), { recursive: true, force: true });

      await _checkNamespaceFsHealthForTesting();

      // Reconnected: live views back, farm never lost, counter reset.
      expect(isNamespaceFsMounted()).toBe(true);
      expect(addon.mountCalls).toHaveLength(2);
      expect(addon.unmountCalls).toBe(1); // one teardown before the remount
      expect(existsSync(join(nsRoot, "home"))).toBe(true);
      expect(_reconnectAttemptsForTesting()).toBe(0);
    });

    it("gives up into fuseless after the reconnect cap, never throwing", async () => {
      // Empty mount hook: the initial sanity passes only because we
      // pre-create proc/ by hand; every remount then fails its sanity.
      mkdirSync(join(nsRoot, "proc"), { recursive: true });
      const addon = fakeAddon({});
      expect(
        (await mountNamespaceFs({ mode: "auto", vfs, nsRoot, addon })).mounted,
      ).toBe(true);

      // Break it: proc/ gone, and the hook won't recreate it.
      rmSync(join(nsRoot, "proc"), { recursive: true, force: true });

      // Drive ticks until the watchdog gives up (cap + 1). It must never
      // throw and must always leave the farm intact.
      for (let i = 0; i < 7; i++) {
        await _checkNamespaceFsHealthForTesting();
        expect(isNamespaceFsMounted()).toBe(false);
        expect(existsSync(join(nsRoot, "home"))).toBe(true);
      }

      expect(namespaceFsStatus().reason).toContain("gave up");
      // Timer stopped — a further tick is a no-op, no more remount attempts.
      const mountsAtGiveUp = addon.mountCalls.length;
      await _checkNamespaceFsHealthForTesting();
      expect(addon.mountCalls.length).toBe(mountsAtGiveUp);
    });
  },
);

// ── Fake addon ───────────────────────────────────────────────────────────────

type FakeAddon = NativeFuseFs & {
  mountCalls: {
    mountpoint: string;
    symlinks: { name: string; target: string }[];
    synthetic: string[];
  }[];
  unmountCalls: number;
};

function fakeAddon(hooks: {
  mount?: (
    mountpoint: string,
    symlinks: { name: string; target: string }[],
    synthetic: string[],
  ) => void;
}): FakeAddon {
  const addon: FakeAddon = {
    mountCalls: [],
    unmountCalls: 0,
    version: () => "test",
    mount(mountpoint, symlinks, synthetic) {
      hooks.mount?.(mountpoint, symlinks, synthetic);
      addon.mountCalls.push({ mountpoint, symlinks, synthetic });
    },
    reply: () => {},
    unmount() {
      addon.unmountCalls += 1;
    },
  };
  return addon;
}
