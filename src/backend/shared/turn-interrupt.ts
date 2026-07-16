/**
 * User-driven mid-turn interrupts, shared by the callback backends
 * (Codex, OpenAI Agents, Kilo, OpenCode). The Claude SDK backend has a
 * native `Query.interrupt()` and doesn't come through here.
 *
 * A handler registers how to stop its in-flight turn when the turn
 * starts and unregisters when it settles; `interruptChatTurn` — the
 * shared implementation of `ChatBackend.interruptChatTurn` — invokes it.
 *
 * The registered closure must make the turn end the way a model-fired
 * terminator does: mark `state.turnTerminated` FIRST, then fire the
 * native abort. Every backend's close-out logic already keys off that
 * flag — abort errors are swallowed as the expected close, wrap-up
 * round-trips are skipped, and the flow-violation retry (which would
 * otherwise resurrect a killed turn as a "missed delivery") stands
 * down. The stream then settles as a normal completion carrying the
 * partial text and real usage — never as an error, never as a retry.
 */

import { log, logWarn } from "../../util/log.js";
import { incrementCounter } from "../../util/metrics.js";

const interrupts = new Map<string, () => void | Promise<void>>();

/**
 * Register the abort path for a chat's in-flight turn. Returns the
 * unregister function; it only removes its own registration, so a retry
 * that re-registered for the same chat is never torn down by the
 * attempt that spawned it.
 */
export function registerTurnInterrupt(
  chatId: string,
  interrupt: () => void | Promise<void>,
): () => void {
  interrupts.set(chatId, interrupt);
  return () => {
    if (interrupts.get(chatId) === interrupt) interrupts.delete(chatId);
  };
}

/**
 * Best-effort interrupt of the chat's in-flight turn. Resolves `true`
 * when a running turn was found and signalled, `false` otherwise —
 * the `ChatBackend.interruptChatTurn` contract.
 */
export async function interruptChatTurn(chatId: string): Promise<boolean> {
  const interrupt = interrupts.get(chatId);
  if (!interrupt) return false;
  try {
    await interrupt();
    log("agent", `[${chatId}] turn interrupted by user`);
    incrementCounter("turn_interrupted");
    return true;
  } catch (err) {
    logWarn(
      "agent",
      `[${chatId}] interrupt failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}
