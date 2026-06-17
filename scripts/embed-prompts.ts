/**
 * `npm run build:prompts` — regenerate
 * src/core/prompt/embedded-prompts.ts from the .md files under prompts/.
 * See src/core/prompt/embed.ts.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildEmbeddedPromptsModule,
  listPromptAssets,
} from "../src/core/prompt/embed.js";

const promptsDir = fileURLToPath(new URL("../prompts", import.meta.url));
const target = fileURLToPath(
  new URL("../src/core/prompt/embedded-prompts.ts", import.meta.url),
);

writeFileSync(target, buildEmbeddedPromptsModule(listPromptAssets(promptsDir)));
console.log(`wrote ${target}`);
