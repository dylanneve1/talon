/**
 * The one flag that gates the typed memory store's read path
 * (docs/memory-persona-rollout.md, "One flag gates the whole new path").
 *
 * Kept in its own module because `core/prompt/assemble.ts` asks the
 * question but must not reach into `storage/` to answer it: the prompt
 * layer sees the flag and the core view, nothing else.
 *
 * Read per call, never cached: tests flip it between builds, and the
 * cost is an env lookup on a path that already reads files from disk.
 */

/** True when `TALON_MEMORY_STORE=1`. Off by default until PR 9 is measured. */
export function memoryStoreEnabled(): boolean {
  return process.env.TALON_MEMORY_STORE === "1";
}
