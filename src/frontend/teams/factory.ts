/**
 * Teams frontend factory — attaches the create half of the registry
 * entry (descriptor registered in core/frontend-runtime). The
 * implementation (Bot Framework + Graph) loads only when created.
 */

import { attachFrontendCreate } from "../../core/frontend-runtime/index.js";

attachFrontendCreate("teams", async (config, gateway) => {
  const { createTeamsFrontend } = await import("./index.js");
  return createTeamsFrontend(config, gateway);
});
