/**
 * Drift guard for the embedded prompt manifest — rebuilds
 * core/prompt/embedded-prompts.ts from the .md sources under prompts/ and
 * fails if the committed artifact doesn't match (same idiom as the SQL
 * embed / Gleam artifact guards). Run `npm run build:prompts` to refresh.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildEmbeddedPromptsModule,
  listPromptAssets,
} from "../core/prompt/embed.js";

const promptsDir = fileURLToPath(new URL("../../prompts", import.meta.url));
const generatedPath = fileURLToPath(
  new URL("../core/prompt/embedded-prompts.ts", import.meta.url),
);

describe("prompts embed", () => {
  it("embedded-prompts.ts matches the .md sources (run `npm run build:prompts`)", () => {
    const expected = buildEmbeddedPromptsModule(listPromptAssets(promptsDir));
    // CRLF-normalize the committed artifact so a Windows checkout without
    // a line-ending pin doesn't diff on EOLs alone.
    const committed = readFileSync(generatedPath, "utf8").replaceAll(
      "\r\n",
      "\n",
    );
    expect(committed).toBe(expected);
  });

  it("embeds every system template and the dream prompt", () => {
    const rels = listPromptAssets(promptsDir);
    expect(rels).toContain("dream.md");
    expect(rels).toContain("system/cron.md");
    expect(rels).toContain("system/persistent-memory.md");
    // System templates referenced by loadSystemTemplate() must be present.
    expect(rels.filter((r) => r.startsWith("system/")).length).toBeGreaterThan(
      0,
    );
  });
});
