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
import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import makeWASocket, {
  isJidGroup,
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
import { pushMessage, maxMsgIdForChatPrefix } from "../../storage/history.js";
import {
  recordMessageProcessed,
  recordMessageReceived,
} from "../../util/watchdog.js";
import { createWhatsAppActionHandler } from "./actions/index.js";
import {
  bareId,
  canonicalId,
  identityAllowed,
  resolveIdentity,
} from "./identity.js";
import { sendText, setWhatsAppBotName } from "./actions/shared.js";
import { saveInboundMedia } from "./media-store.js";
import {
  lookupByWaId,
  rememberMessage,
  seedMessageStore,
} from "./message-store.js";
import { runTurnWithRecovery, shouldReplyToCatchUp } from "./turn-recovery.js";
import { classifyClose, REPLACED_BACKOFF_MS } from "./pairing.js";
import { isManualPairingActive, onPairingComplete } from "./pairing-lock.js";
import { flushAuthWrites, useAtomicAuthState } from "./auth-state.js";
import { makeWaLogger } from "./wa-logger.js";
import { notifyAdmin } from "../../core/notify.js";
import { registerPairingProvider } from "../../core/pairing-broker.js";
import { beginPairingAttempt } from "./pairing-service.js";
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
  /** One "not linked" admin note per outage, not one per QR window. */
  let unpairedNotified = false;
  /** Our own ids (phone and LID), once connected — for mention detection. */
  let selfIds: string[] = [];

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
      // A participant is listed by whichever form the group uses, so
      // check every id WhatsApp gives us for them.
      allowed = meta.participants.some((p) =>
        [p.id, p.lid, p.phoneNumber]
          .filter((id): id is string => Boolean(id))
          .some((id) => allowedDms.has(bareId(id))),
      );
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
    if (selfIds.length === 0) return false;
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const isSelf = (j: string): boolean => selfIds.includes(bareId(j));
    if ((ctx?.mentionedJid ?? []).some(isSelf)) return true;
    return Boolean(ctx?.participant && isSelf(ctx.participant));
  }

  async function handleInbound(
    msg: WAMessage,
    opts: { catchUp?: boolean } = {},
  ): Promise<void> {
    const jid = msg.key.remoteJid;
    // `fromMe` covers our own sends echoing back; status@broadcast is the
    // Stories feed, which is not a conversation.
    if (!jid || jid === "status@broadcast" || msg.key.fromMe) return;

    const isGroup = Boolean(isJidGroup(jid));
    // The sender may be addressed by phone number or by LID depending on
    // their privacy settings; resolve both before matching an allowlist
    // that is written in phone numbers.
    const senderJid = msg.key.participant || jid;
    const identity = await resolveIdentity(
      sock,
      senderJid,
      msg.key.participantAlt ?? msg.key.remoteJidAlt,
    );

    // ── Access gates: the allowlists are the entire permission model ──
    if (isGroup) {
      if (!(await isGroupAllowed(jid))) return;
      if (settings.respondMode === "mention" && !isAddressedToSelf(msg)) return;
    } else if (!identityAllowed(identity, allowedDms)) {
      log(
        "whatsapp",
        `Ignoring DM from unlisted ${identity.ids.join("/") || bareId(jid)}`,
      );
      return;
    }

    const text = extractText(msg).trim();
    // Group chats key on the group JID; DMs key on the person, so the
    // thread survives WhatsApp switching addressing form.
    const chat = registerWhatsAppChat(
      jid,
      undefined,
      isGroup ? undefined : canonicalId(identity),
    );
    const senderName = msg.pushName || canonicalId(identity) || "user";
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
    const platformTs = Number(msg.messageTimestamp) * 1000;
    pushMessage(chat.chatId, {
      msgId,
      senderId: Number(BigInt(canonicalId(identity) ?? "0") % 2147483647n),
      senderName,
      senderHandle: canonicalId(identity),
      text,
      // The platform timestamp, so a catch-up message recorded late still
      // reads in true order; Date.now() only when Baileys omits it.
      timestamp:
        Number.isFinite(platformTs) && platformTs > 0 ? platformTs : Date.now(),
      ...(replyTo ? { replyToMsgId: replyTo.msgId } : {}),
      ...(media ? { mediaType: media.type, filePath: media.filePath } : {}),
    });

    // ── Slash commands ──
    const trimmed = text.toLowerCase();
    if (trimmed === "/reset") {
      await performSessionReset(
        chat.chatId,
        resolveChatBackend(chat.chatId, gateway.backend),
        // The local history store is WhatsApp's only chat record — a
        // reset clears the model's session, not the conversation log.
        { keepHistory: true },
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
          "*Commands*\n/reset — start a fresh session (chat log kept)\n/help — this message",
        ).catch(() => {});
      }
      recordMessageProcessed();
      return;
    }

    // Catch-up messages (queued while the daemon was down) get a reply
    // turn only while fresh; stale ones are already recorded above and
    // the next live turn reads them from history.
    if (opts.catchUp) {
      if (!shouldReplyToCatchUp(platformTs)) {
        log(
          "whatsapp",
          `[${chat.chatId}] Recorded offline message from ${senderName} (history only — too old for a reply turn)`,
        );
        recordMessageProcessed();
        return;
      }
      log(
        "whatsapp",
        `[${chat.chatId}] Catch-up: replying to offline message from ${senderName}`,
      );
    }

    const preview = text || `(${media?.type ?? "media"})`;
    log(
      "whatsapp",
      `[${chat.chatId}] [${senderName}]: ${preview.slice(0, 80)}${preview.length > 80 ? "..." : ""}`,
    );
    appendDailyLog(senderName, preview, {
      chatTitle: chat.title,
      username: canonicalId(identity) ?? bareId(jid),
    });

    // The model addresses messages by numeric id (react/reply/edit), so the
    // id travels with the text the same way the other frontends do it.
    const mediaNote = media
      ? `\n[attached ${media.type}: ${media.filePath}]`
      : "";
    const prompt = `[${senderName}] msg_id:${msgId}: ${text}${mediaNote}`;

    const runTurn = () =>
      execute({
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

    await runTurnWithRecovery({
      chatId: chat.chatId,
      senderName,
      runTurn,
      sendErrorText: async (text) => {
        if (!sock) return;
        try {
          await sendText({ sock, gateway }, chat, text);
        } catch (sendErr) {
          logError(
            "whatsapp",
            `error delivery failed: ${sendErr instanceof Error ? sendErr.message : sendErr}`,
          );
        }
      },
    });
  }

  /** One socket lifetime. Resolves with what the caller should do next. */
  async function connectOnce(): Promise<
    "reconnect" | "logged-out" | "unpaired" | "stop"
  > {
    // Atomic replacement for Baileys' useMultiFileAuthState — same disk
    // format, torn-write-proof (see auth-state.ts for why that matters).
    const { state, saveCreds } = await useAtomicAuthState(dirs.whatsappAuth);
    const socket = makeWASocket({
      auth: state,
      logger: makeWaLogger(),
      markOnlineOnConnect: false,
      // The account is a bot: announcing "online" would suppress the
      // phone's own notifications for the human who owns the number.
      //
      // 120s per QR/pairing ref — the default (60s + 20s refreshes) gave
      // a ~2½-minute socket lifetime in pairing mode, shorter than it
      // takes a human to pick up their phone and type the code.
      qrTimeout: 120_000,
      // OpenClaw's production timings: the Baileys 20s connect timeout
      // is tight on a loaded box, and a slightly faster keepalive spots
      // a dead transport sooner.
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
    });
    sock = socket;
    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is a live message. "append" is everything delivered out
      // of band — chiefly messages QUEUED WHILE THE DAEMON WAS DOWN
      // (Baileys marks offline-queued nodes as append), but also our own
      // sends echoing back and newsletter posts, which handleInbound's
      // fromMe/allowlist gates drop. Dropping append wholesale meant any
      // message sent during a restart simply vanished: never recorded,
      // never answered. Appends are processed as catch-up: always
      // recorded, replied to only while fresh.
      if (type !== "notify" && type !== "append") return;
      const catchUp = type === "append";
      for (const msg of messages) {
        void handleInbound(msg, { catchUp }).catch((err) => {
          logError(
            "whatsapp",
            `inbound handler failed: ${err instanceof Error ? err.message : err}`,
          );
        });
      }
    });

    return new Promise((resolve) => {
      socket.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !state.creds.registered) {
          // The frontend NEVER requests pairing codes on its own — that
          // loop once burned ~30 codes in 80 minutes and rate-limited
          // the account. Pairing is on demand via /whatsapp pair
          // (core/pairing-broker.ts). The terminal QR stays for
          // foreground first-run setups without a Telegram admin.
          log(
            "whatsapp",
            "Not linked — pair on demand with /whatsapp pair (Telegram), " +
              "or scan below: WhatsApp → Linked devices → Link a device",
          );
          qrcode.generate(qr, { small: true });
          if (!unpairedNotified) {
            unpairedNotified = true;
            void notifyAdmin(
              "📱 WhatsApp is not linked. Send /whatsapp pair when you're " +
                "ready and I'll reply with a QR to scan.",
            );
          }
        }

        if (connection === "open") {
          // Both forms: a group can @-mention us by either.
          selfIds = [socket.user?.id, socket.user?.lid]
            .filter((id): id is string => Boolean(id))
            .map(bareId);
          reconnectDelay = RECONNECT_BASE_MS;
          if (unpairedNotified) {
            void notifyAdmin("✅ WhatsApp linked and connected.");
          }
          unpairedNotified = false;
          log(
            "whatsapp",
            `Connected as ${socket.user?.name ?? "?"} (${selfIds.join("/") || "?"})`,
          );
        }

        if (connection === "close") {
          const code = (
            lastDisconnect?.error as
              { output?: { statusCode?: number } } | undefined
          )?.output?.statusCode;
          if (stopping) return resolve("stop");
          const disposition = classifyClose(code, state.creds.registered);
          switch (disposition.kind) {
            case "pairing-accepted":
              // 515 right after a pairing code/QR is SUCCESS, not an
              // error: WhatsApp requires one reconnect with the same
              // credentials to complete the login.
              log(
                "whatsapp",
                "Pairing accepted (515) — reconnecting to complete login",
              );
              reconnectDelay = RECONNECT_BASE_MS;
              return resolve("reconnect");
            case "replaced":
              // Another socket owns this session (440). Fighting it with
              // an instant reconnect just steals the session back and
              // forth; sit out a full minute instead.
              logWarn(
                "whatsapp",
                "Connection replaced by another client (440) — backing off",
              );
              reconnectDelay = REPLACED_BACKOFF_MS;
              return resolve("reconnect");
            case "logged-out":
              return resolve("logged-out");
            default:
              // A socket that died without ever registering is a pairing
              // window that expired — reconnecting would just open QR
              // session after QR session against WhatsApp's servers.
              // Park instead; /whatsapp pair opens the next one.
              if (!state.creds.registered) return resolve("unpaired");
              log(
                "whatsapp",
                `Connection closed (code ${code ?? "?"}) — reconnecting`,
              );
              return resolve("reconnect");
          }
        }
      });
    });
  }

  /**
   * Wait until a manual pairing completes (event from pairing-lock) or
   * registered creds appear on disk, polling slowly. Resolves promptly
   * when the frontend is stopping.
   */
  async function parkUntilPaired(): Promise<void> {
    while (!stopping) {
      if (!isManualPairingActive()) {
        try {
          const raw = await readFile(
            resolvePath(dirs.whatsappAuth, "creds.json"),
            "utf-8",
          );
          if ((JSON.parse(raw) as { registered?: boolean }).registered) return;
        } catch {
          /* no creds yet — stay parked */
        }
      }
      const paired = await new Promise<boolean>((r) => {
        const off = onPairingComplete(() => {
          clearTimeout(timer);
          off();
          r(true);
        });
        const timer = setTimeout(() => {
          off();
          r(false);
        }, 30_000);
        timer.unref?.();
      });
      if (paired) return;
    }
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
      setWhatsAppBotName(config.botDisplayName);
      // On-demand pairing, driven from another frontend's admin command
      // (/whatsapp pair on Telegram) through the core broker.
      registerPairingProvider({
        label: "WhatsApp",
        isLinked: () => Boolean(sock?.user),
        begin: () => beginPairingAttempt(settings.pairingNumber),
      });
      // The in-memory message-id counter restarts at its base every boot,
      // but history persists — seed it past what the table already holds
      // so post-restart messages don't re-issue ids INSERT OR IGNORE then
      // silently drops (chat ids all start with "wa_").
      seedMessageStore((maxMsgIdForChatPrefix("wa_") ?? 0) + 1);
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
        // A manual pairing attempt owns the auth dir: two sockets on one
        // keypair corrupt it and burn rate-limited pairing attempts.
        if (isManualPairingActive()) {
          await new Promise((r) => setTimeout(r, 5_000));
          continue;
        }
        let outcome: "reconnect" | "logged-out" | "unpaired" | "stop";
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
          // Wipe them and PARK. Re-pairing needs a human holding the
          // phone, so it happens strictly on demand (Telegram's
          // `/whatsapp pair`) — every automatic retry policy tried here,
          // including a 30-minute backoff ladder, still burned codes
          // against WhatsApp's rate limit until scans failed with
          // "couldn't connect device" for everyone.
          logWarn(
            "whatsapp",
            "Logged out by WhatsApp — parked until /whatsapp pair re-links",
          );
          void notifyAdmin(
            "⚠️ WhatsApp unlinked this device. When you're ready to " +
              "re-link, send /whatsapp pair and scan the QR I reply with. " +
              "Nothing is retried until then.",
          );
          rmSync(dirs.whatsappAuth, { recursive: true, force: true });
          await parkUntilPaired();
          reconnectDelay = RECONNECT_BASE_MS;
          continue;
        }
        if (outcome === "unpaired") {
          log("whatsapp", "Not paired — parked until /whatsapp pair links");
          await parkUntilPaired();
          reconnectDelay = RECONNECT_BASE_MS;
          continue;
        }
        await new Promise((r) => setTimeout(r, reconnectDelay));
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
      log("whatsapp", "WhatsApp connection loop ended");
    },

    async stop() {
      stopping = true;
      registerPairingProvider(null);
      try {
        sock?.end(undefined);
      } catch {
        /* already closed */
      }
      sock = null;
      // Drain queued credential writes before the process exits — a key
      // half-written at shutdown is invisible until the server starts
      // rejecting stanzas with it.
      await flushAuthWrites();
      await gateway.stop();
      log("whatsapp", "WhatsApp frontend stopped");
    },
  };
}
