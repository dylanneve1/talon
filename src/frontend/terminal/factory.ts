/**
 * Terminal frontend factory — attaches the create half of the
 * registry entry (descriptor registered in core/frontend-runtime).
 */

import { attachFrontendCreate } from "../../core/frontend-runtime/index.js";

attachFrontendCreate("terminal", async (config, gateway) => {
  const { createTerminalFrontend } = await import("./index.js");
  return createTerminalFrontend(config, gateway);
});
