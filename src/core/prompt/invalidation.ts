/**
 * Prompt-input invalidation — the core-side seam callers use when prompt
 * inputs change out from under live sessions on purpose (plugin reload,
 * skill toggle).
 *
 * Whoever caches assembled prompts registers a hook here (today: the
 * per-session snapshot store in backend/shared/system-prompt.ts, at its
 * module load). Core and frontends call `notifyPromptInputsChanged()`
 * and never import the cache — the dependency points backend → core,
 * as the layer rule requires.
 */

const hooks = new Set<() => void>();

/** Register a callback run whenever prompt inputs are invalidated. */
export function onPromptInputsChanged(hook: () => void): void {
  hooks.add(hook);
}

/** Invalidate: every registered prompt cache drops its state. */
export function notifyPromptInputsChanged(): void {
  for (const hook of hooks) hook();
}
