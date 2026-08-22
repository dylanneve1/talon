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
 */

import { rmSync } from "node:fs";
import makeWASocket, {
  DisconnectReason,
  isJidGroup,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from "baileys";
import qrcode from "qrcode-terminal";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { log, logError, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import { execute } from "../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../core/agent-runtime/events.js";
import { resolveChatBackend } from "../../core/engine/backend-controller/index.js";
import { performSessionReset } from "../shared/session-status.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { pushMessage } from "../../storage/history.js";
import {
  recordError,
  recordMessageProcessed,
  recordMessageReceived,
  recordMessageSettled,
} from "../../util/watchdog.js";
import { createWhatsAppActionHandler } from "./actions/index.js";
import { sendText } from "./actions/shared.js";
import { saveInboundMedia } from "./media-store.js";
import { lookupByWaId, rememberMessage } from "./message-store.js";
import {
  lookupWhatsAppChat,
  registerWhatsAppChat,
  type WhatsAppChatInfo,
} from "./registry.js";

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

type WhatsAppSettings = {
  allowedJids: string[];
  allowedGroups: string[];
  groupPolicy: "listed" | "with-allowed-user" | "all";
  respondMode: "mention" | "all";
  pairingNumber?: string;
  sendReadReceipts: boolean;
};

/** Reconnect backoff: WhatsApp throttles a client that hammers it. */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * How long a group's membership answer is trusted. Group metadata costs a
 * round-trip, and the `with-allowed-user` policy would otherwise pay it on
 * every inbound message; memberships change on the order of days.
 */
const GROUP_POLICY_CACHE_MS = 10 * 60_000;

/** Bare identity of a JID or phone string: "353851722396". */
function bareId(jidOrNumber: string): string {
  return jidOrNumber.split("@")[0].split(":")[0].replace(/^\+/, "");
}

/** Plain text of an inbound message, across the wrappers WhatsApp uses. */
function extractText(msg: WAMessage): string {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    ""
  );
}

/**
 * Baileys logs through its own pino instance, far too chatty for a daemon
 * that already has structured logging. Bridge warn+ into Talon's log and
 * drop the rest. The shape is pino's minimal logger contract.
 */
function makeWaLogger(): never {
  const fmt = (args: unknown[]): string =>
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")
      .slice(0, 300);
  const shim = {
    level: "warn",
    child: () => shim,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => logWarn("whatsapp", `baileys: ${fmt(args)}`),
    error: (...args: unknown[]) =>
      logError("whatsapp", `baileys: ${fmt(args)}`),
    fatal: (...args: unknown[]) =>
      logError("whatsapp", `baileys: ${fmt(args)}`),
  };
  return shim as never;
}

// ── Frontend factory ─────────────────────────────────────────────────────────

export function createWhatsAppFrontend(
  config: TalonConfig,
  gateway: Gateway,
): WhatsAppFrontend {
  const settings: WhatsAppSettings = {
    allowedJids: [],
    allowedGroups: [],
    groupPolicy: "listed",
    respondMode: "mention",
    sendReadReceipts: true,
    ...((config as Record<string, unknown>).whatsapp as
      Partial<WhatsAppSettings> | undefined),
  };
  const allowedDms = new Set(settings.allowedJids.map(bareId));
  const allowedGroups = new Set(settings.allowedGroups.map(bareId));

  let sock: WASocket | null = null;
  let stopping = false;
  let reconnectDelay = RECONNECT_BASE_MS;
  /** Our own account id (bare), once connected — for mention detection. */
  let selfId: string | null = null;

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "whatsapp"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  function chatFor(numericChatId: number): WhatsAppChatInfo | null {
    const info = lookupWhatsAppChat(numericChatId);
    if (!info) {
      logWarn("whatsapp", `No JID registered for chat ${numericChatId}`);
      return null;
    }
    return info;
  }

  /** Cached `groupPolicy` verdicts, keyed by group JID. */
  const groupAllowCache = new Map<string, { allowed: boolean; at: number }>();

  /**
   * May the bot act in this group? `allowedGroups` is always honoured;
   * beyond it the policy decides, and "with-allowed-user" asks WhatsApp
   * who is in the group (cached — see GROUP_POLICY_CACHE_MS).
   */
  async function isGroupAllowed(jid: string): Promise<boolean> {
    if (allowedGroups.has(bareId(jid))) return true;
    if (settings.groupPolicy === "listed") return false;
    if (settings.groupPolicy === "all") return true;

    const cached = groupAllowCache.get(jid);
    if (cached && Date.now() - cached.at < GROUP_POLICY_CACHE_MS) {
      return cached.allowed;
    }
    let allowed = false;
    try {
      const meta = await sock!.groupMetadata(jid);
      allowed = meta.participants.some((p) => allowedDms.has(bareId(p.id)));
    } catch (err) {
      // A metadata failure must not silently open the group up.
      logWarn(
        "whatsapp",
        `Group policy check failed for ${jid}: ${err instanceof Error ? err.message : err}`,
      );
    }
    groupAllowCache.set(jid, { allowed, at: Date.now() });
    return allowed;
  }

  /** Is this group message addressed to us — @mentioned or quoting us? */
  function isAddressedToSelf(msg: WAMessage): boolean {
    if (!selfId) return false;
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if ((ctx?.mentionedJid ?? []).some((j) => bareId(j) === selfId))
      return true;
    return Boolean(ctx?.participant && bareId(ctx.participant) === selfId);
  }

  async function handleInbound(msg: WAMessage): Promise<void> {
    const jid = msg.key.remoteJid;
    // `fromMe` covers our own sends echoing back; status@broadcast is the
    // Stories feed, which is not a conversation.
    if (!jid || jid === "status@broadcast" || msg.key.fromMe) return;

    const isGroup = Boolean(isJidGroup(jid));
    // ── Access gates: the allowlists are the entire permission model ──
    if (isGroup) {
      if (!(await isGroupAllowed(jid))) return;
      if (settings.respondMode === "mention" && !isAddressedToSelf(msg)) return;
    } else if (!allowedDms.has(bareId(jid))) {
      log("whatsapp", `Ignoring DM from unlisted ${bareId(jid)}`);
      return;
    }

    const text = extractText(msg).trim();
    const chat = registerWhatsAppChat(jid);
    const senderName =
      msg.pushName || bareId(msg.key.participant ?? jid) || "user";
    const msgId = rememberMessage({
      key: msg.key,
      chatId: chat.chatId,
      message: msg,
      text,
      senderName,
    });

    // Media is saved before the turn so the model can open the file by
    // path in the same turn it's told about it.
    const media = await saveInboundMedia(msg, chat.chatId, msgId, senderName);
    if (!text && !media) return; // reaction, receipt, or an unsupported type

    recordMessageReceived();
    if (settings.sendReadReceipts) {
      sock?.readMessages([msg.key]).catch(() => {});
    }

    // Recorded for read_chat_history / search_chat_history, which the core
    // serves from this store for frontends without a platform history API.
    const replyToWaId =
      msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined;
    const replyTo = replyToWaId ? lookupByWaId(replyToWaId) : undefined;
    pushMessage(chat.chatId, {
      msgId,
      senderId: Number(
        BigInt(bareId(msg.key.participant ?? jid) || "0") % 2147483647n,
      ),
      senderName,
      senderHandle: bareId(msg.key.participant ?? jid),
      text,
      timestamp: Date.now(),
      ...(replyTo ? { replyToMsgId: replyTo.msgId } : {}),
      ...(media ? { mediaType: media.type, filePath: media.filePath } : {}),
    });

    // ── Slash commands ──
    const trimmed = text.toLowerCase();
    if (trimmed === "/reset") {
      await performSessionReset(
        chat.chatId,
        resolveChatBackend(chat.chatId, gateway.backend),
      );
      log("whatsapp", `Session reset by ${senderName}`);
      if (sock) {
        await sendText({ sock, gateway }, chat, "Session cleared.").catch(
          () => {},
        );
      }
      recordMessageProcessed();
      return;
    }
    if (trimmed === "/help") {
      if (sock) {
        await sendText(
          { sock, gateway },
          chat,
          "*Commands*\n/reset — clear session & history\n/help — this message",
        ).catch(() => {});
      }
      recordMessageProcessed();
      return;
    }

    const preview = text || `(${media?.type ?? "media"})`;
    log(
      "whatsapp",
      `[${chat.chatId}] [${senderName}]: ${preview.slice(0, 80)}${preview.length > 80 ? "..." : ""}`,
    );
    appendDailyLog(senderName, preview, {
      chatTitle: chat.title,
      username: bareId(msg.key.participant ?? jid),
    });

    // The model addresses messages by numeric id (react/reply/edit), so the
    // id travels with the text the same way the other frontends do it.
    const mediaNote = media
      ? `\n[attached ${media.type}: ${media.filePath}]`
      : "";
    const prompt = `[${senderName}] msg_id:${msgId}: ${text}${mediaNote}`;

    try {
      await execute({
        chatId: chat.chatId,
        numericChatId: chat.numericChatId,
        prompt,
        senderName,
        isGroup,
        source: "message",
        onEvent: async (event) => {
          switch (event.type) {
            case "tool_call": {
              const input = toolInputToRecord(event.name, event.input);
              const detail = (input.description ??
                input.command ??
                input.action ??
                input.query ??
                "") as string;
              log(
                "whatsapp",
                `  tool: ${event.name}${detail ? ` — ${String(detail).slice(0, 100)}` : ""}`,
              );
              break;
            }
            // Progress prose and the end-of-turn trailing-text fallback.
            // Without this, prose-only turns are silently dropped.
            case "assistant_message": {
              if (!event.text.trim() || !sock) break;
              try {
                await sendText({ sock, gateway }, chat, event.text);
              } catch (err) {
                logError(
                  "whatsapp",
                  `onEvent delivery failed: ${err instanceof Error ? err.message : err}`,
                );
              }
              break;
            }
          }
        },
      });
      recordMessageProcessed();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError("whatsapp", `[${chat.chatId}] execute failed: ${message}`);
      recordError(message);
      recordMessageSettled();
    }
  }

  /** One socket lifetime. Resolves with what the caller should do next. */
  async function connectOnce(): Promise<"reconnect" | "logged-out" | "stop"> {
    const { state, saveCreds } = await useMultiFileAuthState(dirs.whatsappAuth);
    const socket = makeWASocket({
      auth: state,
      logger: makeWaLogger(),
      markOnlineOnConnect: false,
      // The account is a bot: announcing "online" would suppress the
      // phone's own notifications for the human who owns the number.
    });
    sock = socket;
    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is a live message; "append" is history sync, which must
      // not trigger turns for conversations that already happened.
      if (type !== "notify") return;
      for (const msg of messages) {
        void handleInbound(msg).catch((err) => {
          logError(
            "whatsapp",
            `inbound handler failed: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    });

    let pairingRequested = false;
    return new Promise((resolve) => {
      socket.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !state.creds.registered) {
          if (settings.pairingNumber && !pairingRequested) {
            pairingRequested = true;
            socket
              .requestPairingCode(bareId(settings.pairingNumber))
              .then((code) =>
                log(
                  "whatsapp",
                  `Pairing code: ${code} — enter it on ${settings.pairingNumber} ` +
                    `via WhatsApp → Linked devices → Link with phone number`,
                ),
              )
              .catch((err) =>
                logError(
                  "whatsapp",
                  `Pairing code request failed: ${err instanceof Error ? err.message : err}`,
                ),
              );
          } else if (!settings.pairingNumber) {
            log(
              "whatsapp",
              "Scan with WhatsApp → Linked devices → Link a device:",
            );
            qrcode.generate(qr, { small: true });
          }
        }

        if (connection === "open") {
          selfId = socket.user?.id ? bareId(socket.user.id) : null;
          reconnectDelay = RECONNECT_BASE_MS;
          log(
            "whatsapp",
            `Connected as ${socket.user?.name ?? "?"} (${selfId ?? "?"})`,
          );
        }

        if (connection === "close") {
          const code = (
            lastDisconnect?.error as
              { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          if (stopping) return resolve("stop");
          if (code === DisconnectReason.loggedOut) return resolve("logged-out");
          log(
            "whatsapp",
            `Connection closed (code ${code ?? "?"}) — reconnecting`,
          );
          return resolve("reconnect");
        }
      });
    });
  }

  return {
    name: "whatsapp",
    context,

    sendTyping: async (chatId: number) => {
      const chat = chatFor(chatId);
      if (!chat || !sock) return;
      await sock.sendPresenceUpdate("composing", chat.jid).catch(() => {});
    },

    sendMessage: async (chatId: number, text: string) => {
      if (!text.trim()) return;
      const chat = chatFor(chatId);
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
      gateway.registerFrontendHandler(
        "whatsapp",
        createWhatsAppActionHandler(() => sock, gateway),
      );
      const port = await gateway.start(19876);
      log("whatsapp", `Gateway on port ${port}`);
    },

    async start() {
      log("whatsapp", "WhatsApp frontend starting (Baileys multi-device)");
      while (!stopping) {
        let outcome: "reconnect" | "logged-out" | "stop";
        try {
          outcome = await connectOnce();
        } catch (err) {
          logError(
            "whatsapp",
            `Socket error: ${err instanceof Error ? err.message : err}`,
          );
          outcome = "reconnect";
        }
        sock = null;
        if (outcome === "stop" || stopping) break;
        if (outcome === "logged-out") {
          // These credentials are dead — WhatsApp unlinked the device.
          // Wipe them so the next attempt pairs fresh instead of looping
          // on a session that can never authenticate.
          logWarn(
            "whatsapp",
            "Logged out by WhatsApp — clearing auth state, re-pairing",
          );
          rmSync(dirs.whatsappAuth, { recursive: true, force: true });
          reconnectDelay = RECONNECT_BASE_MS;
        }
        await new Promise((r) => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
      log("whatsapp", "WhatsApp connection loop ended");
    },

    async stop() {
      stopping = true;
      try {
        sock?.end(undefined);
      } catch {
        /* already closed */
      }
      sock = null;
      await gateway.stop();
      log("whatsapp", "WhatsApp frontend stopped");
    },
  };
}
