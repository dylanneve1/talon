/**
 * Package-owned prompt templates — loader + minimal renderer.
 *
 * Talon's prompt text lives in two places with different ownership:
 *
 *   - **User-editable prompts** (`identity.md`, `base.md`/`custom.md`,
 *     frontend files like `telegram.md`) are seeded once into
 *     `~/.talon/prompts/` and read from there — user edits win, and
 *     package updates deliberately never overwrite them.
 *
 *   - **System templates** (`prompts/system/*.md` — delivery
 *     contracts, capability docs, section wrappers) are read straight
 *     from the PACKAGE directory and are NOT seeded. They describe
 *     runtime behaviour that is versioned with the code (tool names,
 *     flow enforcement, trigger limits); a stale seeded copy would
 *     silently document a contract the code no longer implements.
 *
 * Template syntax — kept deliberately tiny:
 *
 *   - `{{name}}` — substitute the variable (missing → empty string).
 *   - `{{#if name}}…{{/if}}` — keep the enclosed text only when the
 *     variable is present and non-empty. No nesting, no else.
 *
 * Templates are cached per (file, no-vars) read: the file content is
 * read once per process; rendering with vars is pure string work.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Package prompt directory ────────────────────────────────────────────────

/** Absolute path to the package's `prompts/` directory. */
export const PACKAGE_PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../prompts",
);

const SYSTEM_DIR = resolve(PACKAGE_PROMPTS_DIR, "system");

// ── Renderer ────────────────────────────────────────────────────────────────

export type TemplateVars = Record<string, string | undefined>;

/**
 * Render `{{#if name}}…{{/if}}` blocks then `{{name}}` substitutions.
 * Unknown variables render as empty strings — a template must degrade
 * to readable prose when an optional var (e.g. a frontend without
 * reactions) is absent.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const withConditionals = template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_m, name: string, body: string) => (vars[name] ? body : ""),
  );
  return withConditionals.replace(
    /\{\{(\w+)\}\}/g,
    (_m, name: string) => vars[name] ?? "",
  );
}

// ── Loader ──────────────────────────────────────────────────────────────────

const fileCache = new Map<string, string>();

/**
 * Load a system template by name (e.g. `"contract-tool-only"`) and
 * render it with `vars`. Throws if the file is missing — system
 * templates ship with the package, so absence is a packaging bug, not
 * a user-configuration state.
 */
export function loadSystemTemplate(
  name: string,
  vars: TemplateVars = {},
): string {
  const path = resolve(SYSTEM_DIR, `${name}.md`);
  let raw = fileCache.get(path);
  if (raw === undefined) {
    raw = readFileSync(path, "utf-8").trim();
    fileCache.set(path, raw);
  }
  return renderTemplate(raw, vars);
}

/** Test seam: drop the file cache (e.g. after writing fixture templates). */
export function clearTemplateCache(): void {
  fileCache.clear();
}
