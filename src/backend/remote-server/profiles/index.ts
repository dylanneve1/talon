/**
 * Remote-server profiles — the drivers built from `./bind.ts`.
 *
 * One import for `backend/builtins.ts`, which is the only place that
 * lists them (structure rule 4). Adding a member of this family is
 * adding a profile module here and a line there.
 */

export { kiloProfile } from "./kilo.js";
export { opencodeProfile } from "./opencode.js";
