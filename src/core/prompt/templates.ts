/**
 * Package-owned prompt templates — loader + Liquid renderer.
 *
 * Talon's prompt text lives in two places with different ownership:
 *
 *   - **User-editable prompts** (`identity.md`, `base.md`/`custom.md`,
 *     frontend files like `telegram.md`) are seeded once into
 *     `~/.talon/prompts/` and read from there — user edits win, and
 *     package updates deliberately never overwrite them. These are
 *     rendered with plain `{{name}}` string replacement by their
 *     consumers (heartbeat/dream), NOT through Liquid — a user file
 *     must never be able to break prompt assembly with a syntax error.
 *
 *   - **System templates** (`prompts/system/*.md` — delivery
 *     contracts, capability docs, section wrappers) are read straight
 *     from the PACKAGE directory and are NOT seeded. They describe
 *     runtime behaviour that is versioned with the code (tool names,
 *     flow enforcement, trigger limits); a stale seeded copy would
 *     silently document a contract the code no longer implements.
 *
 * System templates are [Liquid](https://liquidjs.com) — `{{name}}`
 * output (missing → empty string, matching the legacy renderer),
 * `{% if %}`/`{% else %}` conditionals, and `{% render 'partial' %}`
 * includes resolved against `prompts/system/`. Liquid was chosen over
 * a homegrown DSL so prompt text can be composed (sections,
 * conditionals, partials) inside fewer files instead of one file per
 * fragment — and over JS-in-template engines because templates stay
 * pure prose: no code execution.
 *
 * Templates are parsed once per process and cached; rendering with
 * vars is pure in-memory work.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Liquid, type Template } from "liquidjs";

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
 * One engine instance per process. `root` lets templates compose via
 * `{% render 'partial-name' %}` against `prompts/system/`. Variables
 * stay lenient (unknown → empty string) — a template must degrade to
 * readable prose when an optional var (e.g. a frontend without
 * reactions) is absent.
 */
const liquid = new Liquid({
  root: SYSTEM_DIR,
  extname: ".md",
  // JS truthiness, not Shopify's: `""` and `0` are falsy. The legacy
  // renderer treated empty-string vars as "absent", and callers rely
  // on it (`truncated: truncated ? "yes" : undefined`-style flags).
  jsTruthy: true,
});

/**
 * Render a raw Liquid template string with `vars`. For one-off
 * strings (tests, dynamic snippets); file templates should go through
 * `loadSystemTemplate`, which caches the parse.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return liquid.parseAndRenderSync(template, vars);
}

// ── Loader ──────────────────────────────────────────────────────────────────

const parseCache = new Map<string, Template[]>();

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
  let parsed = parseCache.get(path);
  if (parsed === undefined) {
    // The filepath argument anchors relative {% render %} resolution.
    parsed = liquid.parse(readFileSync(path, "utf-8").trim(), path);
    parseCache.set(path, parsed);
  }
  return liquid.renderSync(parsed, vars) as string;
}

/** Test seam: drop the parse cache (e.g. after writing fixture templates). */
export function clearTemplateCache(): void {
  parseCache.clear();
}
