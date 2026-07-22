/**
 * Chat-id routing view of the frontend registry, for consumers that
 * only need "whose chat id is this?" (gateway action routing, backend
 * MCP tool scoping, dispatch resolution). Importing this module — not
 * `registry.js` directly — guarantees the built-in descriptors are
 * registered, without pulling in the engine-typed create seam.
 */

import "./builtins.js";

export {
  getFrontendDescriptor,
  resolveFrontendIdAmong,
  resolveOwnerFrontendId,
  type FrontendDescriptor,
} from "./registry.js";
