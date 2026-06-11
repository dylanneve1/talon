/**
 * Prompt subsystem — barrel export.
 *
 * One stop for everything system-prompt:
 *   - `assemble`          — section pipeline + static/dynamic split
 *   - `templates`         — package-owned `prompts/system/*.md` loader
 *   - `workspace-listing` — lazy workspace tree for the dynamic tail
 *
 * The per-session freezing/caching of assembled prompts lives in
 * `backend/shared/system-prompt.ts` (it is a backend concern); the
 * delivery-contract suffix builders live in
 * `backend/shared/delivery-contract.ts`.
 */

export {
  assembleSystemPrompt,
  joinSystemPromptParts,
  MEMORY_INJECT_MAX_CHARS,
  type AssemblePromptInputs,
  type SystemPromptParts,
} from "./assemble.js";

export {
  loadSystemTemplate,
  renderTemplate,
  clearTemplateCache,
  PACKAGE_PROMPTS_DIR,
  type TemplateVars,
} from "./templates.js";

export { renderWorkspaceListing } from "./workspace-listing.js";
