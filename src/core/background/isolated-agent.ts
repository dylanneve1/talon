/**
 * Generic isolated one-shot agent runner.
 *
 * Runs a `background.runOneShotAgent` under a hard timeout with the same
 * abort → bounded-grace → (optional) orphan-eviction discipline heartbeat uses,
 * so any unattended one-shot (heartbeat, dream, decoupled jobs) gets robust
 * cancellation instead of hand-rolling it per caller.
 *
 * Flow: race the agent against a timeout. On timeout, abort the controller and
 * give the backend a bounded grace window to honour it; if it doesn't, optionally
 * ask the backend to evict orphan subprocesses (Linux /proc sweep). Eviction is
 * opt-in via `evictLabel` because it matches subprocesses by an env tag — a
 * caller that shares a tag with another context (e.g. heartbeat) should leave it
 * unset to avoid sweeping the other context's subprocesses.
 */

import type { BackgroundRunner } from "../agent-runtime/capabilities.js";
import type { OneShotAgentParams } from "../types.js";
import { logWarn, logError } from "../../util/log.js";

/** Default bounded grace after an abort before giving up on the backend. */
export const DEFAULT_ABORT_GRACE_MS = 30 * 1000;

export interface IsolatedRunOptions {
  readonly background: BackgroundRunner;
  /** Fully-built one-shot params (must carry an `abortController`). */
  readonly params: OneShotAgentParams;
  /** Hard timeout before the run is aborted. */
  readonly timeoutMs: number;
  /** Bounded grace for the backend to honour the abort (default 30s). */
  readonly abortGraceMs?: number;
  /**
   * When set, evict orphan subprocesses carrying this context tag if the backend
   * ignores the abort. Leave unset when the tag is shared with another context.
   */
  readonly evictLabel?: string;
}

/** Resolves to the value, or the string "timed_out" if `ms` elapses first. */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | "timed_out"> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    handle = setTimeout(() => resolve("timed_out"), ms);
    handle.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/**
 * Run the one-shot under a hard timeout. Throws on timeout (after the grace
 * window) and re-throws any agent error.
 */
export async function runIsolatedAgent(
  opts: IsolatedRunOptions,
): Promise<void> {
  const { background, params, timeoutMs } = opts;
  const graceMs = opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const agentPromise = background.runOneShotAgent(params);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        params.abortController.abort();
      } catch {
        /* ignore */
      }
      reject(new Error(`isolated agent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    // Snapshot + clear before any await so a late timer can't reclassify a
    // non-timeout failure as a timeout (heartbeat learned this the hard way).
    const wasTimeout = timedOut;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (wasTimeout) {
      const settled = await raceWithTimeout(
        agentPromise.catch(() => "settled"),
        graceMs,
      );
      if (settled === "timed_out" && opts.evictLabel) {
        const evict = background.evictOrphanSubprocesses;
        if (evict) {
          evict(opts.evictLabel).catch((sweepErr: unknown) => {
            logError("triggers", "orphan subprocess sweep failed", sweepErr);
          });
        } else {
          logWarn("triggers", "backend ignored abort and has no eviction hook");
        }
      }
    } else {
      await agentPromise.catch(() => {});
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
