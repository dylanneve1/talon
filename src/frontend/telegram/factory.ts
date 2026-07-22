/**
 * Telegram frontend factory — attaches the create half of the
 * registry entry (descriptor registered in core/frontend-runtime).
 * The implementation (grammy + GramJS) loads only when created.
 */

import { attachFrontendCreate } from "../../core/frontend-runtime/index.js";

attachFrontendCreate("telegram", async (config, gateway) => {
  const { createTelegramFrontend } = await import("./index.js");
  return createTelegramFrontend(config, gateway);
});
