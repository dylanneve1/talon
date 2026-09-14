/**
 * WhatsApp frontend — a personal WhatsApp account driven over the
 * multi-device web protocol via Baileys (WebSocket, no browser).
 *
 * AUTH: multi-file credential state under ~/.talon/whatsapp-auth/. First
 * start pairs interactively — a QR code in the terminal, or a pairing
 * code when `whatsapp.pairingNumber` is set. A logged-out close wipes the
 * auth dir and re-pairs, because those credentials are dead.
 *
 * RECEIVE: `messages.upsert` → allowlist gates → media saved to the
 * workspace → history recorded → `execute()`.
 *
 * SEND: the model's delivery tools route through the gateway into
 * `actions/`, which owns the whole WhatsApp API surface.
 *
 * This file is wiring only: it constructs the shared runtime (runtime.ts)
 * and owns the frontend lifecycle. The behaviour lives in the modules —
 * access (allow-lists), inbound (one message → one turn), connection
 * (socket lifecycle, reconnect, park-until-paired).
 */

import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log, logError, logWarn } from "../../util/log.js";
import { maxMsgIdForChatPrefix } from "../../storage/history.js";
import { createWhatsAppActionHandler } from "./actions/index.js";
import { sendText, setWhatsAppBotName } from "./actions/shared.js";
import { seedMessageStore } from "./message-store.js";
import { flushAuthWrites } from "./auth-state.js";
import { registerPairingProvider } from "../../core/pairing-broker.js";
import { beginPairingAttempt } from "./pairing-service.js";
import { runConnectionLoop } from "./connection.js";
import { lookupWhatsAppChat, type WhatsAppChatInfo } from "./registry.js";
import { createWhatsAppRuntime } from "./runtime.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type WhatsAppFrontend = {
  name: "whatsapp";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

function chatFor(numericChatId: number): WhatsAppChatInfo | null {
  const info = lookupWhatsAppChat(numericChatId);
  if (!info) {
    logWarn("whatsapp", `No JID registered for chat ${numericChatId}`);
    return null;
  }
  return info;
}

// ── Frontend factory ─────────────────────────────────────────────────────────

export function createWhatsAppFrontend(
  config: TalonConfig,
  gateway: Gateway,
): WhatsAppFrontend {
  const runtime = createWhatsAppRuntime(config, gateway);

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "whatsapp"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "whatsapp",
    context,

    sendTyping: async (chatId: number) => {
      const chat = chatFor(chatId);
      const sock = runtime.sock;
      if (!chat || !sock) return;
      await sock.sendPresenceUpdate("composing", chat.jid).catch(() => {});
    },

    sendMessage: async (chatId: number, text: string) => {
      if (!text.trim()) return;
      const chat = chatFor(chatId);
      const sock = runtime.sock;
      if (!chat || !sock) return;
      try {
        await sendText({ sock, gateway }, chat, text);
      } catch (err) {
        logError(
          "whatsapp",
          `sendMessage failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      setWhatsAppBotName(config.botDisplayName);
      // On-demand pairing, driven from another frontend's admin command
      // (/whatsapp pair on Telegram) through the core broker.
      registerPairingProvider({
        label: "WhatsApp",
        isLinked: () => Boolean(runtime.sock?.user),
        begin: () => beginPairingAttempt(runtime.settings.pairingNumber),
      });
      // The in-memory message-id counter restarts at its base every boot,
      // but history persists — seed it past what the table already holds
      // so post-restart messages don't re-issue ids INSERT OR IGNORE then
      // silently drops (chat ids all start with "wa_").
      seedMessageStore((maxMsgIdForChatPrefix("wa_") ?? 0) + 1);
      gateway.registerFrontendHandler(
        "whatsapp",
        createWhatsAppActionHandler(() => runtime.sock, gateway),
      );
      const port = await gateway.start(19876);
      log("whatsapp", `Gateway on port ${port}`);
    },

    start: () => runConnectionLoop(runtime),

    async stop() {
      runtime.stopping = true;
      registerPairingProvider(null);
      try {
        runtime.sock?.end(undefined);
      } catch {
        /* already closed */
      }
      runtime.sock = null;
      // Drain queued credential writes before the process exits — a key
      // half-written at shutdown is invisible until the server starts
      // rejecting stanzas with it.
      await flushAuthWrites();
      await gateway.stop();
      log("whatsapp", "WhatsApp frontend stopped");
    },
  };
}
