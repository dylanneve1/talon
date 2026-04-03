/**
 * GramJS user-account primary frontend.
 *
 * Implements the same TelegramFrontend interface as the Grammy bot frontend
 * but drives everything (receive + send) through a single GramJS user session.
 * No bot token required — only apiId / apiHash + a saved session file.
 *
 * Behaviour parity with the bot frontend:
 *  - Per-user rate limiting (15 msgs / minute)
 *  - Debounced message queue (500ms window, concatenates burst messages)
 *  - All media types: photo, document, voice, video, audio, sticker, gif, video_note
 *  - Group filtering: respond only when @mentioned or replying to one of our messages
 *  - /reset, /restart, /dream handled directly; everything else routed to Claude
 *  - Pulse and cron tick normally (same execute() dispatcher)
 *  - History capture via pushMessage (shared storage)
 *
 * Differences vs bot mode:
 *  - No bot command UI (setMyCommands unavailable for user accounts)
 *  - Streaming (sendMessageDraft) not available — responses delivered as whole blocks
 *  - Inline keyboards sent without buttons (with a warning)
 *  - Bot-API-only actions return { ok: false } from the action handler
 */

import { NewMessage } from "telegram/events/index.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { Api } from "telegram";
import { Raw } from "telegram/events/index.js";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  initUserClient,
  disconnectUserClient,
  fetchSelfInfo,
  getSelfInfo,
  setUserbotPrimary,
  getClient,
  sendUserbotMessage,
  sendUserbotTyping,
  clearUserbotReactions,
  reactUserbotMessage,
  markUserbotAsRead,
  editUserbotMessage,
} from "./client.js";
import { createUserbotActionHandler } from "./actions/index.js";
import { splitMessage, escapeHtml } from "../formatting.js";
import { execute } from "../../../core/dispatcher.js";
import { classify, friendlyMessage } from "../../../core/errors.js";
import {
  enrichDMPrompt,
  enrichGroupPrompt,
} from "../../../core/prompt-builder.js";
import { pushMessage, setMessageFilePath } from "../../../storage/history.js";
import { addMedia } from "../../../storage/media-index.js";
import { appendDailyLog, appendDailyLogResponse } from "../../../storage/daily-log.js";
import { recordMessageProcessed, recordError } from "../../../util/watchdog.js";
import { resetSession } from "../../../storage/sessions.js";
import { clearHistory } from "../../../storage/history.js";
import { forceDream } from "../../../core/dream.js";
import { registerChat } from "../../../core/pulse.js";
import { log, logError, logWarn } from "../../../util/log.js";
import type { TalonConfig } from "../../../util/config.js";
import type { ContextManager } from "../../../core/types.js";
import type { Gateway } from "../../../core/gateway.js";
import type { TelegramFrontend } from "../index.js";

// ── Our-message tracking (for reply-to-self detection) ───────────────────────
// We track message IDs of messages WE sent so that when someone replies to one
// of them in a group we know to respond — replies don't always include @mention.

const ourMessages = new Map<string, Set<number>>(); // chatId → Set<msgId>
const OUR_MSG_CAP = 500; // per-chat cap to bound memory

export function recordOurMessage(chatId: string, msgId: number): void {
  let set = ourMessages.get(chatId);
  if (!set) {
    set = new Set();
    ourMessages.set(chatId, set);
  }
  set.add(msgId);
  if (set.size > OUR_MSG_CAP) {
    const iter = set.values();
    for (let i = 0; i < 50; i++) set.delete(iter.next().value as number);
  }
}

export function isOurMessage(chatId: string, msgId: number): boolean {
  return ourMessages.get(chatId)?.has(msgId) ?? false;
}

/** Reset rate limit state for a sender (or all senders if no argument). Used in tests. */
export function clearRateLimits(senderId?: number): void {
  if (senderId !== undefined) userTimestamps.delete(senderId);
  else userTimestamps.clear();
}

/** Reset our-message tracking for a chat (or all chats if no argument). Used in tests. */
export function clearOurMessageTracking(chatId?: string): void {
  if (chatId !== undefined) ourMessages.delete(chatId);
  else ourMessages.clear();
}

// ── Typing indicator cache ────────────────────────────────────────────────────

const typingCache = new Map<number, number>(); // userId → timestamp of last typing event
const TYPING_TTL = 6_000; // Telegram typing indicator lasts ~5s

/** Check if a user is currently typing. */
export function isUserTyping(userId: number): boolean {
  const ts = typingCache.get(userId);
  if (!ts) return false;
  if (Date.now() - ts > TYPING_TTL) {
    typingCache.delete(userId);
    return false;
  }
  return true;
}

// ── Keyword watches ───────────────────────────────────────────────────────────

type KeywordWatch = {
  keyword: string;
  chatId?: number;
  createdAt: string;
};

let watchCache: KeywordWatch[] | null = null;
let watchCacheTime = 0;
const WATCH_CACHE_TTL = 15_000; // re-read file every 15s

function loadWatches(): KeywordWatch[] {
  const now = Date.now();
  if (watchCache !== null && now - watchCacheTime < WATCH_CACHE_TTL) return watchCache;
  const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
  try {
    watchCache = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[];
  } catch {
    watchCache = [];
  }
  watchCacheTime = now;
  return watchCache;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const userTimestamps = new Map<number, number[]>();
const RL_WINDOW = 60_000;
const RL_MAX = 15;

export function isRateLimited(senderId: number): boolean {
  const now = Date.now();
  const ts = userTimestamps.get(senderId) ?? [];
  const fresh = ts.filter((t) => t > now - RL_WINDOW);
  if (fresh.length >= RL_MAX) {
    userTimestamps.set(senderId, fresh);
    return true;
  }
  fresh.push(now);
  userTimestamps.set(senderId, fresh);
  return false;
}

// ── Debounce queue ────────────────────────────────────────────────────────────

type QueuedMsg = {
  prompt: string;
  replyToId: number;
  messageId: number;
  senderName: string;
  senderUsername?: string;
  senderId?: number;
  isGroup: boolean;
  chatTitle?: string;
};

type QueueEntry = {
  messages: QueuedMsg[];
  timer: ReturnType<typeof setTimeout>;
  numericChatId: number;
  queuedReactionMsgIds: number[];
};

const queues = new Map<string, QueueEntry>();
const DEBOUNCE_MS = 500;
const MAX_QUEUED = 20;

function enqueue(
  chatId: string,
  numericChatId: number,
  msg: QueuedMsg,
): void {
  const existing = queues.get(chatId);
  if (existing) {
    if (existing.messages.length >= MAX_QUEUED) return;
    existing.messages.push(msg);
    // Hourglass reaction to show we've seen it
    reactUserbotMessage(numericChatId, msg.messageId, "⏳").catch(() => {});
    existing.queuedReactionMsgIds.push(msg.messageId);
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => flushQueue(chatId), DEBOUNCE_MS);
    return;
  }
  queues.set(chatId, {
    messages: [msg],
    timer: setTimeout(() => flushQueue(chatId), DEBOUNCE_MS),
    numericChatId,
    queuedReactionMsgIds: [],
  });
}

async function flushQueue(chatId: string): Promise<void> {
  const entry = queues.get(chatId);
  if (!entry) return;
  queues.delete(chatId);

  const { messages, numericChatId, queuedReactionMsgIds } = entry;

  // Show typing indicator immediately so the user knows we're processing
  sendUserbotTyping(numericChatId).catch(() => {});

  // Clear hourglass reactions and mark chat as read
  for (const msgId of queuedReactionMsgIds) {
    clearUserbotReactions(numericChatId, msgId).catch(() => {});
  }
  // Mark all messages as read so the chat doesn't show an unread badge
  markUserbotAsRead(numericChatId).catch(() => {});

  const last = messages[messages.length - 1];
  const combinedPrompt =
    messages.length === 1
      ? messages[0].prompt
      : messages.map((m) => m.prompt).join("\n\n");

  appendDailyLog(last.senderName, combinedPrompt, {
    chatTitle: last.chatTitle,
    username: last.senderUsername,
  });

  try {
    await processMessage({
      chatId,
      numericChatId,
      replyToId: last.replyToId,
      messageId: last.messageId,
      prompt: combinedPrompt,
      senderName: last.senderName,
      senderUsername: last.senderUsername,
      senderId: last.senderId,
      isGroup: last.isGroup,
      chatTitle: last.chatTitle,
    });
    recordMessageProcessed();
  } catch (err) {
    const classified = classify(err);
    const chatType = last.isGroup ? "group" : "DM";
    logError(
      "userbot-frontend",
      `[${chatId}] [${chatType}] [${last.senderName}] ${classified.reason}: ${classified.message}`,
    );
    recordError(classified.message);

    if (classified.retryable) {
      const delay = classified.retryAfterMs ?? 2000;
      log("userbot-frontend", `[${chatId}] Retrying after ${classified.reason} (${delay}ms)...`);
      await new Promise((r) => setTimeout(r, delay));
      try {
        await processMessage({
          chatId, numericChatId, replyToId: last.replyToId,
          messageId: last.messageId, prompt: combinedPrompt,
          senderName: last.senderName, senderUsername: last.senderUsername,
          senderId: last.senderId, isGroup: last.isGroup, chatTitle: last.chatTitle,
        });
        return;
      } catch (retryErr) {
        const rc = classify(retryErr);
        logError("userbot-frontend", `[${chatId}] Retry failed: ${rc.message}`);
        await sendError(numericChatId, friendlyMessage(rc), last.replyToId);
        return;
      }
    }

    await sendError(numericChatId, friendlyMessage(classified), last.replyToId);
  }
}

// ── Process & reply ───────────────────────────────────────────────────────────

type ProcessParams = {
  chatId: string;
  numericChatId: number;
  replyToId: number;
  messageId: number;
  prompt: string;
  senderName: string;
  senderUsername?: string;
  senderId?: number;
  isGroup: boolean;
  chatTitle?: string;
};

const knownDmSenders = new Set<number>();

// ── Online status cache ───────────────────────────────────────────────────────
// Populated by watching UpdateUserStatus updates via Raw event handler.

type CachedStatus = {
  status: "online" | "offline" | "recently" | "unknown";
  expiresAt?: number; // for online: when the session expires (unix ms)
  wasOnlineAt?: number; // for offline: last seen (unix ms)
  cachedAt: number; // when we cached this
};

const onlineStatusCache = new Map<number, CachedStatus>();

/** Get cached online status for a user ID (returns null if not cached). */
export function getCachedOnlineStatus(userId: number): CachedStatus | null {
  return onlineStatusCache.get(userId) ?? null;
}

async function processMessage(params: ProcessParams): Promise<void> {
  const {
    chatId, numericChatId, replyToId, messageId,
    prompt, senderName, senderUsername, senderId, isGroup, chatTitle,
  } = params;

  let enriched = prompt;
  if (!isGroup && senderName) {
    enriched = enrichDMPrompt(prompt, senderName, senderUsername);
    if (senderId && !knownDmSenders.has(senderId)) {
      knownDmSenders.add(senderId);
      log("userbot-frontend", `New DM sender: ${senderName}${senderUsername ? ` (@${senderUsername})` : ""} [id:${senderId}]`);
      appendDailyLog("System", `New DM sender: ${senderName}${senderUsername ? ` (@${senderUsername})` : ""} [id:${senderId}]`);
    }
  } else if (isGroup && senderId) {
    enriched = enrichGroupPrompt(prompt, chatId, senderId);
  }

  // Append unread count context for DMs so Claude knows about pending chats
  if (!isGroup) {
    const client = getClient();
    if (client) {
      try {
        // Quick check: count dialogs with unread > 0 excluding current chat
        const dialogs = await client.getDialogs({ limit: 30 });
        const unreadOthers = dialogs.filter((d) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dAny = d as any;
          const dId = dAny.entity?.id ? Number(dAny.entity.id) : 0;
          return dAny.unreadCount > 0 && dId !== numericChatId;
        }).length;
        if (unreadOthers > 0) {
          enriched += `\n\n[You have ${unreadOthers} other chat${unreadOthers === 1 ? "" : "s"} with unread messages]`;
        }
      } catch { /* best-effort — don't block on this */ }
    }
  }

  const MAX = 4096;

  const onTextBlock = async (text: string) => {
    const chunks = splitMessage(text, MAX);
    for (const chunk of chunks) {
      const msgId = await sendUserbotMessage(numericChatId, chunk, replyToId);
      recordOurMessage(chatId, msgId);
    }
  };

  const result = await execute({
    chatId,
    numericChatId,
    prompt: enriched,
    senderName,
    isGroup,
    messageId,
    source: "message",
    onTextBlock,
    onToolUse: (toolName, input) => {
      if (toolName === "send" && input.type === "text" && typeof input.text === "string") {
        appendDailyLogResponse("Talon", input.text, { chatTitle });
      }
    },
  });

  if (result.bridgeMessageCount === 0 && result.text?.trim()) {
    log("userbot-frontend", `Suppressed fallback text — no send tool used`);
  }
}

async function sendError(chatId: number, text: string, replyTo?: number): Promise<void> {
  try {
    const msgId = await sendUserbotMessage(chatId, escapeHtml(text), replyTo);
    recordOurMessage(String(chatId), msgId);
  } catch (e) {
    logError("userbot-frontend", "Failed to send error message", e);
  }
}

// ── Media download ────────────────────────────────────────────────────────────

async function downloadGramJSMedia(
  media: Api.TypeMessageMedia | null | undefined,
  filename: string,
  workspace: string,
): Promise<string> {
  const client = getClient();
  if (!client || !media) throw new Error("No client or no media");

  const buffer = (await client.downloadMedia(media, {})) as Buffer;
  if (!buffer || buffer.length === 0) throw new Error("Download returned empty data");

  const uploadsDir = resolve(workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  writeFileSync(destPath, buffer);
  return destPath;
}

// ── Group filter ──────────────────────────────────────────────────────────────

export function shouldHandleInGroup(
  message: NewMessageEvent["message"],
  chatId: string,
  selfUsername: string | undefined,
  selfId: bigint,
): boolean {
  const text = message.text ?? "";
  // @mention check (case-insensitive, word-boundary)
  const mentioned =
    selfUsername &&
    new RegExp(`@${selfUsername}(?![a-zA-Z0-9_])`, "i").test(text);
  if (mentioned) return true;
  // Reply-to-self check
  const replyToId = message.replyTo?.replyToMsgId;
  if (replyToId && isOurMessage(chatId, replyToId)) return true;
  return false;
}

// ── Command handling ──────────────────────────────────────────────────────────

async function handleCommand(
  cmd: string,
  chatId: string,
  numericChatId: number,
  msgId: number,
  adminUserId: number | undefined,
  senderId: number | undefined,
  cmdArg?: string,
): Promise<boolean> {
  const isAdmin = adminUserId && senderId === adminUserId;
  const {
    renderStatus, renderSettings, renderHelp, renderPing, renderMemory,
    renderPlugins, handleModelCommand, handleEffortCommand, handlePulseCommand,
    handleReset, renderAdminHealth, renderAdminChats,
  } = await import("../command-ui.js");
  const { formatDuration } = await import("../helpers.js");

  const reply = async (text: string) => {
    const id = await sendUserbotMessage(numericChatId, text, msgId);
    recordOurMessage(chatId, id);
  };
  const F = "markdown" as const;

  switch (cmd) {
    case "help":
    case "commands": {
      await reply(renderHelp(undefined, F));
      return true;
    }
    case "status": {
      await reply(renderStatus(chatId, "default", F));
      return true;
    }
    case "settings": {
      await reply(renderSettings(chatId, "default", F));
      return true;
    }
    case "model": {
      await reply(handleModelCommand(chatId, cmdArg?.trim() || undefined, "default", F));
      return true;
    }
    case "effort": {
      await reply(handleEffortCommand(chatId, cmdArg?.trim().toLowerCase() || undefined, F));
      return true;
    }
    case "pulse": {
      const text = handlePulseCommand(chatId, cmdArg?.trim().toLowerCase() || undefined, F);
      if (cmdArg?.trim().toLowerCase() === "on") registerChat(chatId);
      await reply(text);
      return true;
    }
    case "ping": {
      const start = Date.now();
      const { isUserClientReady } = await import("./client.js");
      await reply(renderPing(Date.now() - start, isUserClientReady()));
      return true;
    }
    case "reset": {
      await reply(handleReset(chatId));
      return true;
    }

    case "dream": {
      if (adminUserId && senderId !== adminUserId) {
        await reply("Admin only.");
        return true;
      }
      const statusId = await sendUserbotMessage(numericChatId, "🌙 Dream mode starting...", msgId);
      recordOurMessage(chatId, statusId);
      const start = Date.now();
      try {
        await forceDream();
        await editUserbotMessage(numericChatId, statusId, `🌙 Dream complete — memory consolidated in ${formatDuration(Date.now() - start)}.`);
      } catch (err) {
        await editUserbotMessage(numericChatId, statusId, `🌙 Dream failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    case "restart": {
      if (!isAdmin) { await reply("Admin only."); return true; }
      await reply("♻️ Restarting…");
      setTimeout(() => process.exit(0), 500);
      return true;
    }

    case "memory": {
      await reply(renderMemory());
      return true;
    }

    case "plugins": {
      await reply(renderPlugins(F));
      return true;
    }

    case "admin": {
      if (!isAdmin) { await reply("Not authorized."); return true; }
      const sub = cmdArg?.trim().split(/\s+/)[0] ?? "";
      if (sub === "chats") { await reply(renderAdminChats(F)); return true; }
      await reply(renderAdminHealth(F));
      return true;
    }

    default:
      return false; // let Claude handle it
  }
}

// ── Sender helpers ────────────────────────────────────────────────────────────

export function getSenderName(entity: unknown): string {
  if (!entity) return "User";
  const e = entity as { firstName?: string; lastName?: string; title?: string };
  return [e.firstName, e.lastName].filter(Boolean).join(" ") || e.title || "User";
}

export function getSenderUsername(entity: unknown): string | undefined {
  if (!entity) return undefined;
  return (entity as { username?: string }).username ?? undefined;
}

export function getSenderId(entity: unknown): number | undefined {
  if (!entity) return undefined;
  const id = (entity as { id?: bigint | number }).id;
  return id !== undefined ? Number(id) : undefined;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createUserbotFrontend(
  config: TalonConfig,
  gateway: Gateway,
  options?: {
    /** Called when an incoming message passes the group filter and will be processed. */
    onChatOwned?: (chatId: number) => void;
    /**
     * When false, does NOT call setUserbotPrimary(true) — used in dual mode where the
     * bot frontend is also active. The scope guard stays active; allowChat() is called
     * per message instead. Default: true.
     */
    primaryMode?: boolean;
    /**
     * Dual-mode dedup: called before processing a message. Returns false if the
     * other frontend already claimed this message → skip processing.
     */
    claimMessage?: (chatId: number, msgId: number) => boolean;
  },
): TelegramFrontend {
  const context: ContextManager = {
    acquire: (chatId: number) => gateway.setContext(chatId),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    context,

    sendTyping: (chatId: number) => sendUserbotTyping(chatId),

    sendMessage: async (chatId: number, text: string) => {
      const msgId = await sendUserbotMessage(chatId, text);
      recordOurMessage(String(chatId), msgId);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      // Only bypass scope guard when running as the sole frontend
      if (options?.primaryMode !== false) setUserbotPrimary(true);

      // Register GramJS action handler
      gateway.setFrontendHandler(
        createUserbotActionHandler(gateway, recordOurMessage),
      );

      const port = await gateway.start(19876);
      log("userbot-frontend", `Gateway started on port ${port}`);

      // Connect user client
      const ok = await initUserClient({
        apiId: config.apiId!,
        apiHash: config.apiHash!,
      });
      if (!ok) {
        throw new Error(
          "User client not authorized. Run: npx tsx src/login.ts with the new API credentials.",
        );
      }

      // Cache self info for group mention detection
      await fetchSelfInfo();
      const self = getSelfInfo();
      if (self) {
        log(
          "userbot-frontend",
          `Running as ${self.firstName ?? ""} ${self.username ? `@${self.username}` : ""} (id:${self.id})`,
        );
      }
    },

    async start() {
      const client = getClient();
      if (!client) throw new Error("User client not initialized.");

      const self = getSelfInfo();
      const selfId = self?.id ?? 0n;
      const selfUsername = self?.username;

      // ── Main message event handler ─────────────────────────────────────────
      client.addEventHandler(async (event: NewMessageEvent) => {
        const message = event.message;
        if (!message) return;

        // Convert BigInt peer ID to number — safe for all Telegram ID ranges
        const numericChatId = Number(message.chatId ?? 0n);
        if (!numericChatId) return;
        // In dual mode, prefix session key so userbot has separate Claude sessions
        // from the bot (even in the same group chat). The numeric peer stays unchanged
        // for Telegram API calls.
        const chatId = options?.primaryMode === false
          ? `ub:${numericChatId}`
          : String(numericChatId);

        const peerClass = message.peerId?.className;
        const isGroup = peerClass === "PeerChat" || peerClass === "PeerChannel";

        // Fetch sender entity (async, cached by GramJS internally)
        let senderEntity: unknown = null;
        try {
          senderEntity = await message.getSender();
        } catch { /* best-effort */ }

        const senderName = getSenderName(senderEntity);
        const senderUsername = getSenderUsername(senderEntity);
        const senderId = Number(message.senderId ?? 0n) || getSenderId(senderEntity);

        // Ignore our own outgoing messages (NewMessage incoming:true should already
        // filter these, but guard against edge cases with anonymous/channel posts)
        if (senderId && senderId === Number(selfId)) return;

        // Register for pulse (groups only)
        if (isGroup) registerChat(chatId);

        const msgId = message.id;
        const replyToId = message.replyTo?.replyToMsgId ?? msgId;
        const timestamp = (message.date ?? 0) * 1000;

        // ── History capture (all messages, before filtering) ───────────────
        const rawText = message.text || message.message || "";
        const mediaClass = message.media?.className;
        let historyText = rawText;
        let historyMediaType: "photo" | "document" | "voice" | "video" | "animation" | "sticker" | undefined;

        if (!rawText) {
          if (message.photo) { historyText = message.message || "(photo)"; historyMediaType = "photo"; }
          else if (message.voice) { historyText = "(voice message)"; historyMediaType = "voice"; }
          else if (message.videoNote) { historyText = "(video note)"; historyMediaType = "video"; }
          else if (message.gif) { historyText = message.message || "(GIF)"; historyMediaType = "animation"; }
          else if (message.video) { historyText = message.message || "(video)"; historyMediaType = "video"; }
          else if (message.sticker) { historyText = `${(message.sticker as { attributes?: Array<{ alt?: string; className?: string }> }).attributes?.find(a => a.className === "DocumentAttributeSticker")?.alt ?? ""}(sticker)`; historyMediaType = "sticker"; }
          else if (message.audio) { historyText = message.message || "(audio)"; historyMediaType = "document"; }
          else if (message.document) {
            const fnAttr = (message.document as { attributes?: Array<{ className?: string; fileName?: string }> }).attributes?.find(a => a.className === "DocumentAttributeFilename");
            historyText = message.message || `(sent ${fnAttr?.fileName ?? "file"})`;
            historyMediaType = "document";
          }
          else if (mediaClass === "MessageMediaPoll") {
            // Capture poll question for history
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pollQ = (message.media as any)?.poll?.question?.text ?? "poll";
            historyText = `(poll: "${pollQ}")`;
          }
          else if (mediaClass === "MessageMediaUnsupported") {
            historyText = `(unsupported media — msg_id:${msgId})`;
          }
          else if (mediaClass) { historyText = `(${mediaClass})`; }
        }

        if (historyText) {
          pushMessage(chatId, {
            msgId,
            senderId: senderId ?? 0,
            senderName,
            text: historyText,
            replyToMsgId: message.replyTo?.replyToMsgId,
            timestamp,
            mediaType: historyMediaType,
          });
        }

        // ── Keyword watch check ────────────────────────────────────────────
        const watches = loadWatches();
        const matchedKeywords = rawText
          ? watches.filter(
              (w) =>
                rawText.toLowerCase().includes(w.keyword.toLowerCase()) &&
                (!w.chatId || w.chatId === numericChatId),
            )
          : [];
        const keywordAlertPrefix =
          matchedKeywords.length > 0
            ? `[KEYWORD ALERT: "${matchedKeywords.map((w) => w.keyword).join('", "')}"] `
            : "";
        const forceHandleByKeyword = matchedKeywords.length > 0;

        // ── Group filter ───────────────────────────────────────────────────
        if (isGroup) {
          let handle = forceHandleByKeyword || shouldHandleInGroup(message, chatId, selfUsername, selfId);
          if (!handle) {
            // ourMessages map is empty after restart — fall back to fetching the
            // replied-to message from Telegram and checking if WE sent it.
            const replyToId = message.replyTo?.replyToMsgId;
            if (replyToId) {
              try {
                const c = getClient();
                if (c) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const msgs = await c.getMessages(numericChatId as any, { ids: [replyToId] });
                  const replied = msgs[0];
                  if (replied && Number(replied.senderId ?? 0n) === Number(selfId)) {
                    recordOurMessage(chatId, replyToId); // warm cache for future replies
                    handle = true;
                  }
                }
              } catch { /* best-effort */ }
            }
          }
          if (!handle) return;
        }

        // Notify dual-mode coordinator which frontend owns this chat
        options?.onChatOwned?.(numericChatId);

        // Mark as read immediately so the unread badge clears right away
        markUserbotAsRead(numericChatId, message.id).catch(() => {});

        // ── Rate limit ─────────────────────────────────────────────────────
        if (senderId && isRateLimited(senderId)) return;

        // ── Get chat title for context ─────────────────────────────────────
        let chatTitle: string | undefined;
        if (isGroup) {
          try {
            const chatEntity = await message.getChat();
            if (chatEntity) {
              chatTitle = "title" in chatEntity
                ? (chatEntity as { title?: string }).title
                : "firstName" in chatEntity
                  ? (chatEntity as { firstName?: string }).firstName
                  : undefined;
            }
          } catch { /* best-effort */ }
        }

        // ── Command handling (/cmd text) ───────────────────────────────────
        if (rawText.startsWith("/")) {
          const [cmdPart, ...argParts] = rawText.split(/\s+/);
          const cmd = cmdPart.slice(1).split("@")[0].toLowerCase();
          const cmdArg = argParts.join(" ");
          const handled = await handleCommand(
            cmd, chatId, numericChatId, msgId,
            config.adminUserId, senderId, cmdArg,
          ).catch((e) => {
            logError("userbot-frontend", `Command /${cmd} failed`, e);
            return false;
          });
          if (handled) return;
          // Unrecognised command → fall through to Claude
        }

        // ── Text message ───────────────────────────────────────────────────
        if (rawText && !message.media) {
          const replyPrefix = message.replyTo?.replyToMsgId
            ? `[Replying to msg:${message.replyTo.replyToMsgId}]\n\n`
            : "";
          const prompt = keywordAlertPrefix + replyPrefix + rawText;

          enqueue(chatId, numericChatId, {
            prompt,
            replyToId,
            messageId: msgId,
            senderName,
            senderUsername,
            senderId,
            isGroup,
            chatTitle,
          });
          return;
        }

        // ── Media messages ─────────────────────────────────────────────────
        if (!message.media) return; // nothing to process

        const caption = message.message || "";

        try {
          // ── Photo ──────────────────────────────────────────────────────
          if (message.photo) {
            const savedPath = await downloadGramJSMedia(
              message.media,
              `photo_${msgId}.jpg`,
              config.workspace,
            );
            setMessageFilePath(chatId, msgId, savedPath);
            addMedia({ chatId, msgId, senderName, type: "photo", filePath: savedPath, caption, timestamp });
            const prompt = [
              caption ? `Caption: ${caption}` : "",
              `User sent a photo saved to: ${savedPath}`,
              "Read this file to view it. Re-read it in future turns if you need to reference it.",
            ].filter(Boolean).join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Voice ──────────────────────────────────────────────────────
          if (message.voice) {
            const savedPath = await downloadGramJSMedia(message.media, `voice_${msgId}.ogg`, config.workspace);
            setMessageFilePath(chatId, msgId, savedPath);
            addMedia({ chatId, msgId, senderName, type: "voice", filePath: savedPath, caption, timestamp });
            const prompt = [
              caption,
              `User sent a voice message saved to: ${savedPath}`,
              "Transcribe and respond to the voice message by reading the audio file.",
            ].filter(Boolean).join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Video note (circle) ────────────────────────────────────────
          if (message.videoNote) {
            const savedPath = await downloadGramJSMedia(message.media, `vidnote_${msgId}.mp4`, config.workspace);
            setMessageFilePath(chatId, msgId, savedPath);
            addMedia({ chatId, msgId, senderName, type: "video", filePath: savedPath, caption, timestamp });
            const prompt = `User sent a video note saved to: ${savedPath}\nRead and describe its contents.`;
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── GIF / animation ────────────────────────────────────────────
          if (message.gif) {
            const savedPath = await downloadGramJSMedia(message.media, `gif_${msgId}.mp4`, config.workspace);
            addMedia({ chatId, msgId, senderName, type: "animation", filePath: savedPath, caption, timestamp });
            const prompt = [caption, `User sent a GIF saved to: ${savedPath}`].filter(Boolean).join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Sticker ────────────────────────────────────────────────────
          if (message.sticker) {
            const stickerDoc = message.sticker as { attributes?: Array<{ alt?: string; className?: string }> };
            const emoji = stickerDoc.attributes?.find(a => a.className === "DocumentAttributeSticker")?.alt ?? "🖼";
            const prompt = `User sent a sticker: ${emoji}`;
            addMedia({ chatId, msgId, senderName, type: "sticker", filePath: "", caption: emoji, timestamp });
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Video ──────────────────────────────────────────────────────
          if (message.video) {
            const savedPath = await downloadGramJSMedia(message.media, `video_${msgId}.mp4`, config.workspace);
            setMessageFilePath(chatId, msgId, savedPath);
            addMedia({ chatId, msgId, senderName, type: "video", filePath: savedPath, caption, timestamp });
            const prompt = [caption, `User sent a video saved to: ${savedPath}`].filter(Boolean).join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Audio ──────────────────────────────────────────────────────
          if (message.audio) {
            const audioDoc = message.audio as { attributes?: Array<{ className?: string; title?: string; performer?: string }> };
            const audioAttr = audioDoc.attributes?.find(a => a.className === "DocumentAttributeAudio");
            const trackName = [audioAttr?.performer, audioAttr?.title].filter(Boolean).join(" — ") || "audio";
            const savedPath = await downloadGramJSMedia(message.media, `audio_${msgId}.mp3`, config.workspace);
            setMessageFilePath(chatId, msgId, savedPath);
            addMedia({ chatId, msgId, senderName, type: "audio", filePath: savedPath, caption, timestamp });
            const prompt = [caption, `User sent audio: ${trackName}, saved to: ${savedPath}`].filter(Boolean).join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Generic document ───────────────────────────────────────────
          if (message.document) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const docMedia = message.document as any;
            const fnAttr = (docMedia.attributes as Array<{ className?: string; fileName?: string }> | undefined)?.find(a => a.className === "DocumentAttributeFilename");
            const fileName = fnAttr?.fileName || `document_${msgId}`;
            const sizeBytes = Number(docMedia.size ?? 0);
            if (sizeBytes > 20 * 1024 * 1024) {
              await sendError(numericChatId, "File too large (max 20MB).", replyToId);
              return;
            }
            const savedPath = await downloadGramJSMedia(message.media, fileName, config.workspace);
            setMessageFilePath(chatId, msgId, savedPath);
            addMedia({ chatId, msgId, senderName, type: "document", filePath: savedPath, caption, timestamp });
            const prompt = [
              caption,
              `User sent a document: "${fileName}" (${docMedia.mimeType || "unknown"}).`,
              `Saved to: ${savedPath}`,
              "Read and process this file.",
            ].filter(Boolean).join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Unsupported media (client layer too old for this type) ─────
          if (mediaClass === "MessageMediaUnsupported") {
            const prompt = [
              `[Unsupported media] msg_id:${msgId}`,
              "Telegram sent media this client can't decode (session layer mismatch).",
              `Use get_message_by_id(${msgId}) to attempt retrieval, or ask the sender to resend.`,
            ].join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // ── Poll ──────────────────────────────────────────────────────
          if (mediaClass === "MessageMediaPoll") {
            const pollMedia = message.media as { poll?: { question?: { text?: string }; answers?: Array<{ text?: { text?: string } }> }; results?: { results?: Array<{ chosen?: boolean; voters?: number }> } };
            const question = pollMedia.poll?.question?.text ?? "?";
            const answers = (pollMedia.poll?.answers ?? []).map((a, i) => {
              const res = pollMedia.results?.results?.[i];
              const voters = res?.voters ?? 0;
              const chosen = res?.chosen ? " ✓" : "";
              return `  ${i}: ${a.text?.text ?? "?"}${chosen} (${voters} votes)`;
            });
            const prompt = [
              `[Poll] msg_id:${msgId} — "${question}"`,
              answers.join("\n"),
              `Use vote_poll(message_id=${msgId}, option_index=N) to vote.`,
            ].join("\n");
            enqueue(chatId, numericChatId, { prompt, replyToId, messageId: msgId, senderName, senderUsername, senderId, isGroup, chatTitle });
            return;
          }

          // Unknown media — log and ignore
          logWarn("userbot-frontend", `[${chatId}] Unhandled media type: ${mediaClass ?? "unknown"}`);
        } catch (err) {
          logError("userbot-frontend", `[${chatId}] Media handling error`, err);
          await sendError(numericChatId, friendlyMessage(err), replyToId);
        }
      }, new NewMessage({ incoming: true }));

      // ── User status change tracking ────────────────────────────────────────
      client.addEventHandler((update: Api.TypeUpdate) => {
        if (!(update instanceof Api.UpdateUserStatus)) return;
        const userId = Number(update.userId);
        const status = update.status;
        const now = Date.now();
        if (status instanceof Api.UserStatusOnline) {
          onlineStatusCache.set(userId, {
            status: "online",
            expiresAt: status.expires * 1000,
            cachedAt: now,
          });
        } else if (status instanceof Api.UserStatusOffline) {
          onlineStatusCache.set(userId, {
            status: "offline",
            wasOnlineAt: status.wasOnline * 1000,
            cachedAt: now,
          });
        } else if (status instanceof Api.UserStatusRecently) {
          onlineStatusCache.set(userId, { status: "recently", cachedAt: now });
        } else {
          onlineStatusCache.set(userId, { status: "unknown", cachedAt: now });
        }
      }, new Raw({ types: [Api.UpdateUserStatus] }));

      // ── Edit detection ────────────────────────────────────────────────────
      client.addEventHandler((update: Api.TypeUpdate) => {
        try {
          let editedMsg: Api.Message | undefined;
          if (update instanceof Api.UpdateEditMessage) {
            editedMsg = update.message as Api.Message;
          } else if (update instanceof Api.UpdateEditChannelMessage) {
            editedMsg = update.message as Api.Message;
          }
          if (!editedMsg || !editedMsg.message) return;

          const editChatId = Number(editedMsg.chatId ?? (
            editedMsg.peerId && "channelId" in editedMsg.peerId
              ? Number((editedMsg.peerId as any).channelId)
              : ((editedMsg.peerId as any)?.userId ? Number((editedMsg.peerId as any).userId) : 0)
          ));
          if (!editChatId) return;
          const editChatIdStr = String(editChatId);

          // Only notify for edits in DMs or if the edited message is one we replied to
          const isDM = editedMsg.peerId?.className === "PeerUser";
          const isOurs = isOurMessage(editChatIdStr, editedMsg.id);
          // Skip our own edits
          const editSenderId = (editedMsg as any).fromId?.userId
            ? Number((editedMsg as any).fromId.userId)
            : (editedMsg as any).senderId ? Number((editedMsg as any).senderId) : 0;
          if (editSenderId && BigInt(editSenderId) === selfId) return;

          if (!isDM && !isOurs) return;

          const senderName = editSenderId ? String(editSenderId) : "unknown";
          const editPrompt = `[Message ${editedMsg.id} was edited by user ${senderName}]\nNew text: ${editedMsg.message}`;

          enqueue(editChatIdStr, editChatId, {
            prompt: editPrompt,
            replyToId: editedMsg.id,
            messageId: editedMsg.id,
            senderName,
            isGroup: !isDM,
          });
        } catch (err) {
          logError("userbot-frontend", "Edit detection error", err);
        }
      }, new Raw({ types: [Api.UpdateEditMessage, Api.UpdateEditChannelMessage] }));

      // ── Reaction events ──────────────────────────────────────────────────
      client.addEventHandler((update: Api.TypeUpdate) => {
        try {
          if (!(update instanceof Api.UpdateMessageReactions)) return;
          const reactMsgId = update.msgId;
          const reactPeer = update.peer;
          // Only care about reactions on our messages
          let reactChatId = 0;
          if (reactPeer instanceof Api.PeerUser) reactChatId = Number(reactPeer.userId);
          else if (reactPeer instanceof Api.PeerChat) reactChatId = -Number(reactPeer.chatId);
          else if (reactPeer instanceof Api.PeerChannel) reactChatId = -Number(`100${reactPeer.channelId}`);
          if (!reactChatId) return;
          const reactChatIdStr = String(reactChatId);

          // Only notify for reactions on OUR messages
          if (!isOurMessage(reactChatIdStr, reactMsgId)) return;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const results = (update.reactions as any)?.results ?? [];
          const reactionSummary = results.map((r: any) => {
            const emoji = r.reaction?.emoticon ?? r.reaction?.documentId ?? "?";
            return `${emoji} (${r.count})`;
          }).join(", ");

          if (!reactionSummary) return;

          enqueue(reactChatIdStr, reactChatId, {
            prompt: `[Reaction on msg:${reactMsgId}] ${reactionSummary}`,
            replyToId: reactMsgId,
            messageId: reactMsgId,
            senderName: "system",
            isGroup: reactPeer instanceof Api.PeerChat || reactPeer instanceof Api.PeerChannel,
          });
        } catch {
          // silently ignore reaction event errors
        }
      }, new Raw({ types: [Api.UpdateMessageReactions] }));

      // ── Member join/leave events ──────────────────────────────────────────
      client.addEventHandler((update: Api.TypeUpdate) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const u = update as any;
          let eventChatId = 0;
          let eventUserId = 0;
          let eventType = "";

          if (update instanceof Api.UpdateChatParticipantAdd) {
            eventChatId = -Number(u.chatId);
            eventUserId = Number(u.userId);
            eventType = "joined";
          } else if (update instanceof Api.UpdateChatParticipantDelete) {
            eventChatId = -Number(u.chatId);
            eventUserId = Number(u.userId);
            eventType = "left";
          } else if (update instanceof Api.UpdateChannelParticipant) {
            eventChatId = -Number(`100${u.channelId}`);
            eventUserId = Number(u.userId);
            if (u.newParticipant && !u.prevParticipant) eventType = "joined";
            else if (!u.newParticipant && u.prevParticipant) eventType = "left";
            else if (u.newParticipant?.className === "ChannelParticipantAdmin" && u.prevParticipant?.className !== "ChannelParticipantAdmin") eventType = "promoted to admin";
            else if (u.newParticipant?.className === "ChannelParticipantBanned") eventType = "banned";
            else eventType = "updated";
          }

          if (!eventChatId || !eventUserId || !eventType) return;
          const eventChatIdStr = String(eventChatId);

          // Only notify in chats we're actively participating in
          if (!ourMessages.has(eventChatIdStr)) return;

          log("userbot-frontend", `[${eventChatIdStr}] Member ${eventUserId} ${eventType}`);

          // Only enqueue a prompt for joins/leaves in DMs or active chats
          if (eventType === "joined" || eventType === "left") {
            enqueue(eventChatIdStr, eventChatId, {
              prompt: `[Member event] User ${eventUserId} ${eventType} the chat`,
              replyToId: 0,
              messageId: 0,
              senderName: "system",
              isGroup: true,
            });
          }
        } catch {
          // silently ignore member event errors
        }
      }, new Raw({ types: [Api.UpdateChatParticipantAdd, Api.UpdateChatParticipantDelete, Api.UpdateChannelParticipant] }));

      // ── Typing indicator tracking ─────────────────────────────────────────
      client.addEventHandler((update: Api.TypeUpdate) => {
        try {
          let typingUserId: number | undefined;
          if (update instanceof Api.UpdateUserTyping) {
            typingUserId = Number(update.userId);
          } else if (update instanceof Api.UpdateChatUserTyping) {
            typingUserId = (update.fromId as any)?.userId ? Number((update.fromId as any).userId) : undefined;
          }
          if (!typingUserId) return;
          typingCache.set(typingUserId, Date.now());
        } catch {
          // silently ignore typing detection errors
        }
      }, new Raw({ types: [Api.UpdateUserTyping, Api.UpdateChatUserTyping] }));

      log(
        "userbot-frontend",
        `Listening for messages as ${selfUsername ? `@${selfUsername}` : String(selfId)}`,
      );

      // Block until disconnected (GramJS keeps the event loop alive internally)
      await getClient()!.connect();
    },

    async stop() {
      try { await disconnectUserClient(); log("shutdown", "User client disconnected"); }
      catch (err) { logError("shutdown", "User client disconnect error", err); }
      try { await gateway.stop(); log("shutdown", "Gateway stopped"); }
      catch (err) { logError("shutdown", "Gateway stop error", err); }
    },
  };
}
