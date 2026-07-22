/**
 * Native (client bridge) frontend factory — attaches the create half
 * of the registry entry (descriptor registered in core/frontend-runtime).
 * The bridge server implementation loads only when created.
 */

import { attachFrontendCreate } from "../../core/frontend-runtime/index.js";

attachFrontendCreate("native", async (config, gateway) => {
  const { createNativeFrontend } = await import("./index.js");
  return createNativeFrontend(config, gateway);
});
