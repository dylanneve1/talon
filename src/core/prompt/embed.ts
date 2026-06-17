/**
 * Prompt embedding — turns the `.md` files under `prompts/` into the
 * committed `embedded-prompts.ts` manifest.
 *
 * Unlike the SQL/WASM embeds, prose is NOT stringified into source: the
 * manifest is a list of Bun file-asset imports
 * (`import p from "../../../prompts/x.md" with { type: "file" }`), so the
 * `.md` files stay the source of truth (editor highlighting, user-diffable
 * prompt text) while `bun build --compile` carries their bytes inside the
 * binary — read back with `readFileSync` at runtime.
 *
 * The manifest is reached ONLY through the `bun` condition of the
 * `#prompt-assets` import in package.json. tsx/node/tsc resolve the
 * `default` condition (`disk-prompts.ts`) and never parse the Bun-only
 * import attribute. Same committed-artifact idiom as the Gleam scheduler
 * core and the BLAKE3 WASM module: edit the `.md`, run
 * `npm run build:prompts`, commit both; prompts-embed.test.ts fails CI on
 * drift.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Import specifier prefix from src/core/prompt/ up to the repo `prompts/`. */
const IMPORT_PREFIX = "../../../prompts";

/**
 * Every `.md` under `promptsDir`, as posix paths relative to it, sorted
 * for deterministic output (the drift guard compares byte-for-byte).
 */
export function listPromptAssets(promptsDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".md")) {
        out.push(rel);
      }
    }
  };
  walk(promptsDir, "");
  return out.sort();
}

/** Render the generated `embedded-prompts.ts` source for the given rel paths. */
export function buildEmbeddedPromptsModule(rels: string[]): string {
  const sorted = [...rels].sort();
  const ident = (i: number): string => `asset${i}`;

  const imports = sorted
    .map(
      (rel, i) =>
        `import ${ident(i)} from "${IMPORT_PREFIX}/${rel}" with { type: "file" };`,
    )
    .join("\n");

  const entries = sorted
    .map((rel, i) => `  ${JSON.stringify(rel)}: ${ident(i)},`)
    .join("\n");

  return `// AUTO-GENERATED FILE — DO NOT EDIT.
// Source of truth: the .md files under prompts/.
// Regenerate with \`npm run build:prompts\` (drift-guarded by prompts-embed.test.ts).
//
// Each prompt is embedded as a real file asset via the Bun-only
// \`with { type: "file" }\` import attribute, so \`bun build --compile\`
// carries the .md bytes inside the binary (read back with readFileSync)
// without stringifying prose into source. Reached ONLY through the \`bun\`
// condition of the \`#prompt-assets\` import in package.json — tsx/node/tsc
// load disk-prompts.ts instead.
import { readFileSync } from "node:fs";

${imports}

/** rel path (posix, under prompts/) → embedded file path (/$bunfs/… when compiled). */
const ASSETS: Record<string, string> = {
${entries}
};

/** Read an embedded prompt by its rel path (e.g. "system/cron.md"). */
export function readPromptAsset(rel: string): string {
  const path = ASSETS[rel];
  if (path === undefined) {
    throw new Error(\`embedded prompt asset not found: \${rel}\`);
  }
  return readFileSync(path, "utf8");
}

/** Whether an embedded prompt exists for \`rel\`. */
export function promptAssetExists(rel: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSETS, rel);
}

/**
 * Top-level user-editable prompts to seed into ~/.talon/prompts/
 * (every top-level \`*.md\` except the architecture README; the system/
 * subdirectory is package-owned and read in place).
 */
export function listSeedPrompts(): string[] {
  return Object.keys(ASSETS).filter(
    (rel) => !rel.includes("/") && rel !== "README.md",
  );
}
`;
}
