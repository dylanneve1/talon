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

import type { FS } from "liquidjs";
import { Liquid, type Template } from "liquidjs";
import { promptAssetExists, readPromptAsset } from "#prompt-assets";

// ── Renderer ────────────────────────────────────────────────────────────────

export type TemplateVars = Record<string, string | undefined>;

/**
 * Map a Liquid lookup (a bare partial name or `<name>.md`) to its rel path
 * under the package `prompts/system/` directory. System templates live
 * flat there and are referenced by bare name in `{% render %}`.
 */
const systemRel = (file: string): string => {
  const base = file.split(/[\\/]/).pop() ?? file;
  return `system/${base.endsWith(".md") ? base : `${base}.md`}`;
};

/**
 * A Liquid filesystem backed by the `#prompt-assets` seam instead of the
 * real disk, so `{% render 'partial' %}` includes resolve identically
 * under tsx (reads `prompts/system/*.md` from disk) and a
 * `bun build --compile` binary (reads the same files embedded in the
 * binary). System templates are flat, so resolution is by basename.
 */
const liquidFs: FS = {
  sep: "/",
  dirname: () => ".",
  resolve: (_dir, file, ext) => (file.endsWith(ext) ? file : `${file}${ext}`),
  existsSync: (file) => promptAssetExists(systemRel(file)),
  readFileSync: (file) => readPromptAsset(systemRel(file)),
  exists: (file) => Promise.resolve(promptAssetExists(systemRel(file))),
  readFile: (file) => Promise.resolve(readPromptAsset(systemRel(file))),
  contains: () => Promise.resolve(true),
  containsSync: () => true,
};

/**
 * One engine instance per process. The custom `fs` lets templates compose
 * via `{% render 'partial-name' %}` against `prompts/system/`. Variables
 * stay lenient (unknown → empty string) — a template must degrade to
 * readable prose when an optional var (e.g. a frontend without
 * reactions) is absent.
 */
const liquid = new Liquid({
  fs: liquidFs,
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
  const file = `${name}.md`;
  let parsed = parseCache.get(file);
  if (parsed === undefined) {
    // The filepath argument anchors relative {% render %} resolution
    // (resolved against the prompt-asset seam, not the disk).
    parsed = liquid.parse(readPromptAsset(`system/${file}`).trim(), file);
    parseCache.set(file, parsed);
  }
  return liquid.renderSync(parsed, vars) as string;
}

/** Test seam: drop the parse cache (e.g. after writing fixture templates). */
export function clearTemplateCache(): void {
  parseCache.clear();
}
