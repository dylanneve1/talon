/**
 * WhatsApp frontend factory — attaches the create half of the registry
 * entry (descriptor registered in core/frontend-runtime). The
 * implementation (Baileys socket) loads only when created.
 */

import { attachFrontendCreate } from "../../core/frontend-runtime/index.js";

attachFrontendCreate("whatsapp", async (config, gateway) => {
  const { createWhatsAppFrontend } = await import("./index.js");
  return createWhatsAppFrontend(config, gateway);
});
