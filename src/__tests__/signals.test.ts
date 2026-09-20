/**
 * Bun drops a signal's OS-level handler when any one listener for it is
 * removed (observed on 1.3.9; Node keeps it until the last listener
 * goes). Talon lost every /restart and /update to that between
 * 2026-09-18 and 2026-09-20: write-file-atomic loads and unloads
 * signal-exit around each write, the daemon writes its pidfile that way
 * at boot, and from then on a SIGTERM terminated it with no JS run.
 *
 * The guard re-arms the handler after such a removal. The unit tests
 * pin the wrapper's contract on an EventEmitter; the last one runs the
 * real thing — write-file-atomic, then a self-sent SIGTERM — under a
 * real Bun when one is on PATH.
 */
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { installSignalListenerGuard } from "../core/daemon/signals.js";

const a = (): void => {};
const b = (): void => {};

function guarded(): EventEmitter {
  const em = new EventEmitter();
  installSignalListenerGuard(em, { force: true });
  return em;
}

describe("signal listener guard", () => {
  it("adds a listener after a removal that leaves listeners behind", () => {
    const em = guarded();
    em.on("SIGTERM", a);
    em.on("SIGTERM", b);
    const on = vi.spyOn(em, "on");

    em.removeListener("SIGTERM", b);

    // A fresh `on` is what makes Bun install the handler again.
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe("SIGTERM");
    expect(em.listeners("SIGTERM")).toContain(a);
    expect(em.listeners("SIGTERM")).not.toContain(b);
  });

  it("keeps a single sentinel across repeated removals", () => {
    const em = guarded();
    em.on("SIGTERM", a);
    for (let i = 0; i < 5; i++) {
      em.on("SIGTERM", b);
      em.off("SIGTERM", b);
    }
    // `a` plus one sentinel — not one per removal.
    expect(em.listenerCount("SIGTERM")).toBe(2);
  });

  it("lets the signal fall back to its default once the last real listener goes", () => {
    const em = guarded();
    em.on("SIGTERM", a);
    em.on("SIGTERM", b);
    em.removeListener("SIGTERM", b);
    em.removeListener("SIGTERM", a);
    // No sentinel left behind: a no-op listener would make the process
    // ignore SIGTERM instead of dying to it.
    expect(em.listenerCount("SIGTERM")).toBe(0);
  });

  it("still delivers the signal to the surviving listener", () => {
    const em = guarded();
    const seen = vi.fn();
    em.on("SIGINT", seen);
    em.on("SIGINT", b);
    em.off("SIGINT", b);
    em.emit("SIGINT", "SIGINT");
    expect(seen).toHaveBeenCalledWith("SIGINT");
  });

  it("leaves non-signal events alone", () => {
    const em = guarded();
    em.on("data", a);
    em.on("data", b);
    const on = vi.spyOn(em, "on");
    em.removeListener("data", b);
    expect(on).not.toHaveBeenCalled();
    expect(em.listeners("data")).toEqual([a]);
  });

  it("installs once and can be uninstalled", () => {
    const em = new EventEmitter();
    const uninstall = installSignalListenerGuard(em, { force: true });
    const wrapped = em.removeListener;
    expect(installSignalListenerGuard(em, { force: true })).toBe(uninstall);
    expect(em.removeListener).toBe(wrapped);
    uninstall();
    expect(em.removeListener).toBe(EventEmitter.prototype.removeListener);
  });

  it.skipIf(!!process.versions.bun)("is a no-op off Bun unless forced", () => {
    const em = new EventEmitter();
    installSignalListenerGuard(em);
    expect(em.removeListener).toBe(EventEmitter.prototype.removeListener);
  });
});

const bunAvailable =
  spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!bunAvailable)("signal listener guard under Bun", () => {
  it("keeps a self-sent SIGTERM reaching the handler after write-file-atomic", () => {
    const repo = fileURLToPath(new URL("../..", import.meta.url));
    const writeFileAtomic = createRequire(import.meta.url).resolve(
      "write-file-atomic",
    );
    const dir = mkdtempSync(join(tmpdir(), "talon-sigguard-"));
    try {
      const probe = join(dir, "probe.ts");
      writeFileSync(
        probe,
        [
          `import { installSignalListenerGuard } from ${JSON.stringify(join(repo, "src/core/daemon/signals.ts"))};`,
          `import writeFileAtomic from ${JSON.stringify(writeFileAtomic)};`,
          "installSignalListenerGuard();",
          'process.on("SIGTERM", () => { console.log("HANDLED"); process.exit(0); });',
          `await writeFileAtomic(${JSON.stringify(join(dir, "atomic.txt"))}, "x");`,
          'process.kill(process.pid, "SIGTERM");',
          'setTimeout(() => { console.log("NOT_HANDLED"); process.exit(2); }, 2000);',
          "",
        ].join("\n"),
      );
      const run = spawnSync("bun", [probe], {
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(run.stdout.trim()).toBe("HANDLED");
      expect(run.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
