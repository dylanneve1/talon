/**
 * Frontend runtime — capability contract + registry (the frontend
 * counterpart of `core/agent-runtime`). Import THIS module, not
 * `registry.js` directly: loading it guarantees the built-in
 * descriptors are registered. Routing-only consumers inside the engine
 * import `routing.js` instead, which offers the same guarantee without
 * the engine-typed create seam.
 */

import "./builtins.js";

export type {
  Frontend,
  FrontendCreate,
  FrontendDescriptor,
  FrontendFactory,
} from "./capabilities.js";
export {
  getFrontendDescriptor,
  hasFrontend,
  listFrontends,
  resetFrontendRegistry,
  resolveFrontendIdAmong,
  resolveOwnerFrontendId,
} from "./registry.js";
export {
  attachFrontendCreate,
  createFrontendById,
  registerFrontend,
} from "./create.js";
