/**
 * Centralized process exit handler registry.
 *
 * Each storage module calls registerCleanup() instead of
 * process.on("exit", fn) directly. This keeps exactly ONE
 * "exit" listener on the process regardless of how many modules
 * are loaded — avoiding MaxListenersExceededWarning.
 */

const handlers: Array<() => void> = [];
let registered = false;

/**
 * Register a synchronous cleanup function to run on process exit.
 * Safe to call multiple times across multiple modules — only one
 * process "exit" listener is ever registered.
 */
export function registerCleanup(fn: () => void): void {
  handlers.push(fn);
  if (!registered) {
    registered = true;
    process.on("exit", runAll);
  }
}

function runAll(): void {
  for (const fn of handlers) {
    try {
      fn();
    } catch (err) {
      process.stderr.write(`[cleanup] Handler error: ${err instanceof Error ? err.message : err}\n`);
    }
  }
}
