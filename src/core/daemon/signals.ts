/**
 * Keep OS-level signal handlers armed under Bun.
 *
 * Bun (observed on 1.3.9) uninstalls the process-wide handler for a
 * signal as soon as ANY listener for it is removed — even while other
 * listeners remain:
 *
 *   process.on("SIGTERM", a);
 *   process.on("SIGTERM", b);
 *   process.removeListener("SIGTERM", b);
 *   // `a` is still registered in JS, yet SigCgt in /proc/<pid>/status
 *   // no longer lists SIGTERM: the next one terminates the process
 *   // with the default action, running no JS at all.
 *
 * Node keeps the handler until the last listener goes. Adding any
 * listener makes Bun install the handler again, which is what this
 * guard relies on.
 *
 * Talon hit it through `write-file-atomic`: each call loads signal-exit,
 * which puts its own listeners on the termination signals, and unloads
 * it afterwards, removing them. The daemon writes its pidfile that way
 * while booting — so from that moment every SIGTERM it sent itself
 * (`/restart` and `/update`, before respawn.ts entered the shutdown
 * directly) or received from outside (`talon stop`'s fallback, systemd,
 * docker) killed it outright: no graceful shutdown, no successor, no
 * pidfile cleanup. Every `/update` between 2026-09-18 (the move to Bun)
 * and 2026-09-20 ended this way.
 *
 * The guard wraps `process.removeListener` / `process.off`. After a
 * removal that still leaves real listeners on a signal, it re-adds a
 * no-op sentinel listener (removing any earlier copy first), so the
 * handler is installed again before the caller gets control back. Once
 * the last real listener is gone the sentinel goes too, and the signal
 * falls back to its default action exactly as it would on Node — a
 * lingering no-op listener would otherwise make the process ignore it.
 *
 * Installed by the entry shim (src/index.ts) so every Talon process —
 * daemon, MCP supervisor, handoff watcher — is covered before any
 * library gets a chance to remove a listener. A no-op on other runtimes.
 */

import { isBunRuntime } from "../../util/runtime.js";

type Listener = (...args: unknown[]) => void;

/** The slice of `process` the guard touches; tests pass an EventEmitter. */
export interface SignalEmitter {
  on(event: string | symbol, listener: Listener): unknown;
  removeListener(event: string | symbol, listener: Listener): unknown;
  off?(event: string | symbol, listener: Listener): unknown;
  listeners(event: string | symbol): readonly unknown[];
}

export interface SignalGuardOptions {
  /** Install even off Bun (tests exercise the wrapper on Node). */
  force?: boolean;
}

const SIGNAL_EVENT = /^SIG[A-Z0-9]+$/;

const INSTALLED = Symbol.for("talon.signalListenerGuard");

type Guarded = SignalEmitter & { [INSTALLED]?: () => void };

/** The sentinel. Its only job is to exist, so Bun keeps the handler. */
function talonSignalRearm(): void {}

/**
 * Wrap the emitter's listener removal so a signal never silently loses
 * its OS handler. Idempotent: a second install returns the first one's
 * uninstall. Production never uninstalls; tests do.
 */
export function installSignalListenerGuard(
  target: SignalEmitter = process,
  opts: SignalGuardOptions = {},
): () => void {
  const emitter = target as Guarded;
  if (!opts.force && !isBunRuntime()) return () => {};
  const existing = emitter[INSTALLED];
  if (existing) return existing;

  const originalRemove = emitter.removeListener;
  const originalOff = emitter.off;

  const guardedRemove = function (
    this: Guarded,
    event: string | symbol,
    listener: Listener,
  ): unknown {
    const result = originalRemove.call(this, event, listener);
    if (typeof event !== "string" || !SIGNAL_EVENT.test(event)) return result;
    // Bun has just dropped the handler. What is left decides whether the
    // signal should still be handled at all.
    const remaining = this.listeners(event).filter(
      (fn) => fn !== talonSignalRearm,
    );
    originalRemove.call(this, event, talonSignalRearm);
    if (remaining.length > 0) this.on(event, talonSignalRearm);
    return result;
  };

  emitter.removeListener = guardedRemove;
  if (originalOff) emitter.off = guardedRemove;
  const uninstall = (): void => {
    emitter.removeListener = originalRemove;
    if (originalOff) emitter.off = originalOff;
    delete emitter[INSTALLED];
  };
  emitter[INSTALLED] = uninstall;
  return uninstall;
}
