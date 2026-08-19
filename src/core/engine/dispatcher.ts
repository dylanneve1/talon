/**
 * Dispatcher — execution path for all AI queries.
 *
 * Manages the public dispatcher entry points. The Weaver owns per-chat
 * serialization and the turn runner.
 *
 * Dependencies are injected at startup — this module imports nothing from
 * frontend/ or backend/.
 */

import type { ExecuteParams, ExecuteResult } from "../types.js";
import { log } from "../../util/log.js";
import { taskTable, type KillOutcome } from "../tasks/index.js";
import {
  initWeaver,
  type Weaver,
  type WeaverDeps,
  type ThreadSnapshot,
} from "../weaver/index.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

/**
 * `getBackend` takes the string chat id so it can route per-chat —
 * a chat with a backend override returns its override backend, others
 * fall through to the global chat-role backend. Tests can pass a
 * stub that ignores the chat id. See `core/backend-controller.ts`.
 *
 * `resolveActiveModel` walks the 5-step active-model resolution
 * chain for the chat and returns both the resolved `ModelRef` and
 * the raw string + backend id. When `ref` and `model` are both
 * `null`, the dispatcher refuses to call the backend and replies
 * with a "use /model to pick one" message — submitting an empty
 * model id would either error opaquely or run on the wrong default.
 */
type DispatcherDeps = WeaverDeps;

let weaver: Weaver | null = null;

export function initDispatcher(d: DispatcherDeps): void {
  weaver = initWeaver(d);
  log("dispatcher", "Initialized (per-chat serial, cross-chat parallel)");
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Number of queries currently running. */
export function getActiveCount(): number {
  return weaver?.getActiveCount() ?? 0;
}

/**
 * A live view of every Thread the Loom holds — model/backend warp, in-flight
 * count, and context state per chat. The hub's observability surface for
 * `/status`, drift detection, and remote frontends. Empty before init.
 */
export function snapshot(): ThreadSnapshot[] {
  return weaver?.snapshot() ?? [];
}

/**
 * Stop only this chat's active turn. A later message already waiting in the
 * per-chat FIFO is intentionally left alone and runs after the stop settles.
 */
export function stopCurrentTurn(chatId: string): KillOutcome {
  return taskTable.killRunningTurn(chatId);
}

/**
 * Execute an AI query with full lifecycle management.
 * Same-chat queries are serialized (FIFO) to avoid session conflicts.
 * Different-chat queries run in true parallel.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!weaver) throw new Error("Dispatcher not initialized");
  return weaver.runTurn(params);
}
