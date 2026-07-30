/**
 * Prompt subsystem — barrel export.
 *
 * One stop for everything system-prompt:
 *   - `assemble`          — section pipeline + static/dynamic split
 *   - `memory-view`       — ranked selection of `memory.md` under a budget
 *   - `templates`         — package-owned `prompts/system/*.md` loader
 *   - `workspace-listing` — lazy workspace tree for the dynamic tail
 *
 * The per-session freezing/caching of assembled prompts lives in
 * `backend/shared/system-prompt.ts` (it is a backend concern); the
 * delivery-contract suffix builders live in
 * `backend/shared/delivery-contract.ts`.
 */

export { loadSystemTemplate } from "./templates.js";
