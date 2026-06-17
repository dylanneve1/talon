/**
 * Shared trigger-supervisor state: injected deps, the live child/timeout/log
 * registries, the per-trigger line buffers, the warden-supervised set, and the
 * timing constants. One instance of each lives here and is imported by every
 * trigger submodule so supervision stays coherent.
 */

import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { execute as dispatcherExecute } from "../../engine/dispatcher.js";
import { log } from "../../../util/log.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

export type TriggerDeps = {
  /** Used for terminal "fired"/"errored" wake prompts that go through the model. */
  execute: typeof dispatcherExecute;
};

/** Reassignable on a holder object so submodules see the injected deps. */
export const depsHolder: { deps: TriggerDeps | null } = { deps: null };

/** Live child handles, keyed by trigger id. */
export const children = new Map<string, ChildProcess>();
export const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
export const logStreams = new Map<string, WriteStream>();
/** In-memory line buffer per trigger (most recent N stdout+stderr lines).
 *  Used for fire payloads so we don't have to wait on the log file flushing. */
export const lineBuffers = new Map<string, string[]>();
export const LINE_BUFFER_MAX = 80;

export const SIGTERM_GRACE_MS = 5_000;
export const FIRE_PREFIX = "TALON_FIRE:";

/** Trigger ids currently supervised by the Rust warden harness. */
export const wardened = new Set<string>();
/**
 * Extra headroom before SIGKILLing a warden handle. The warden runs its own
 * TERM → grace → KILL escalation on the child's process group; SIGKILLing the
 * warden mid-escalation would orphan that cleanup.
 */
export const WARDEN_GRACE_SLACK_MS = 2_000;

export function initTriggers(d: TriggerDeps): void {
  depsHolder.deps = d;
  log("triggers", "Initialized");
}

/** Number of triggers currently running. */
export function getRunningCount(): number {
  return children.size;
}
