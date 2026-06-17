/**
 * Disk-backed prompt assets — the `default` condition of the
 * `#prompt-assets` package import. Used by tsx / node / npm installs,
 * where the package source tree (and `prompts/`) is on disk.
 *
 * The Bun twin (`embedded-prompts.ts`, the `bun` condition) reads the same
 * files back from inside a `bun build --compile` binary. Both expose the
 * identical interface so consumers stay condition-agnostic.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the package's `prompts/` directory. */
const PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../prompts",
);

/** Read a package prompt by its rel path (e.g. "system/cron.md"). */
export function readPromptAsset(rel: string): string {
  return readFileSync(resolve(PROMPTS_DIR, rel), "utf8");
}

/** Whether a package prompt exists for `rel`. */
export function promptAssetExists(rel: string): boolean {
  return existsSync(resolve(PROMPTS_DIR, rel));
}

/**
 * Top-level user-editable prompts to seed into ~/.talon/prompts/
 * (every top-level `*.md` except the architecture README; the system/
 * subdirectory is package-owned and read in place).
 */
export function listSeedPrompts(): string[] {
  if (!existsSync(PROMPTS_DIR)) return [];
  return readdirSync(PROMPTS_DIR).filter(
    (f) => f.endsWith(".md") && f !== "README.md",
  );
}
