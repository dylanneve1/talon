/**
 * Discord frontend factory — attaches the create half of the
 * registry entry (descriptor registered in core/frontend-runtime).
 * The implementation (discord.js) loads only when created.
 */

import { attachFrontendCreate } from "../../core/frontend-runtime/index.js";

attachFrontendCreate("discord", async (config, gateway) => {
  const { createDiscordFrontend } = await import("./index.js");
  return createDiscordFrontend(config, gateway);
});
