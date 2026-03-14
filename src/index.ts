import { Bot, InputFile } from "grammy";
import { initAgent, handleMessage } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  loadSessions,
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
  flushSessions,
} from "./sessions.js";
import { splitMessage, markdownToTelegramHtml, friendlyError } from "./telegram.js";
import { startBridge, stopBridge, setBridgeContext, clearBridgeContext, getBridgeMessageCount } from "./bridge.js";
import { pushMessage, clearHistory } from "./history.js";
import { initUserClient, allowChat } from "./userbot.js";
import {
  writeFileSync,
  readFileSync,
  statSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { resolve, basename } from "node:path";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();
loadSessions();
initAgent(config);

const bot = new Bot(config.botToken);

if (!existsSync(config.workspace)) {
  mkdirSync(config.workspace, { recursive: true });
}

// Initialize GramJS user client for full history access (optional)
const apiId = parseInt(process.env.TALON_API_ID || "", 10);
const apiHash = process.env.TALON_API_HASH || "";
if (apiId && apiHash) {
  initUserClient({ apiId, apiHash }).then((ok) => {
    if (ok) console.log("[userbot] Full Telegram history access enabled.");
    else console.log("[userbot] Not authorized. Run: npx tsx src/login.ts");
  }).catch((err) => {
    console.error("[userbot] Init failed:", err instanceof Error ? err.message : err);
  });
} else {
  console.log("[userbot] TALON_API_ID/TALON_API_HASH not set — using in-memory history only.");
}

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply(
    "🦅 <b>Talon</b> — Claude-powered Telegram assistant.\n\n" +
      "Send a message, photo, document, or voice note.\n" +
      "In groups, mention me or reply to my messages.\n\n" +
      "/status — session info &amp; usage\n" +
      "/reset — clear session\n" +
      "/help — all commands",
    { parse_mode: "HTML" },
  ),
);

bot.command("help", (ctx) =>
  ctx.reply(
    [
      "🦅 <b>Talon Commands</b>",
      "",
      "/status — model, context, usage, cost",
      "/reset — clear session, start fresh",
      "/help — this message",
      "",
      "<b>Supported input:</b>",
      "• Text messages",
      "• Photos (with optional caption)",
      "• Documents/files (PDF, code, etc.)",
      "• Voice messages",
      "• Forwarded messages",
      "• Reply context",
      "",
      "<b>Groups:</b> mention @" + escapeHtml(ctx.me.username ?? "bot") + " or reply to activate",
      "",
      "<b>Files:</b> ask me to create a file and I'll send it as an attachment",
    ].join("\n"),
    { parse_mode: "HTML" },
  ),
);

bot.command("reset", async (ctx) => {
  const cid = String(ctx.chat.id);
  resetSession(cid);
  clearHistory(cid);
  await ctx.reply("Session cleared.");
});

bot.command("status", async (ctx) => {
  const info = getSessionInfo(String(ctx.chat.id));
  const u = info.usage;
  const uptime = formatDuration(process.uptime() * 1000);
  const sessionAge = info.createdAt ? formatDuration(Date.now() - info.createdAt) : "—";
  const lastSeen = info.lastActive ? formatTimeAgo(info.lastActive) : "never";

  // Context usage bar
  const contextMax = 1_000_000;
  const contextUsed = u.lastPromptTokens;
  const contextPct = contextMax > 0 ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : 0;
  const barLen = 20;
  const filled = Math.round((contextPct / 100) * barLen);
  const contextBar = "█".repeat(filled) + "░".repeat(barLen - filled);

  // Cache hit rate
  const totalPrompt = u.totalInputTokens + u.totalCacheRead + u.totalCacheWrite;
  const cacheHitPct = totalPrompt > 0 ? Math.round((u.totalCacheRead / totalPrompt) * 100) : 0;

  // Response time stats
  const avgResponseMs = info.turns > 0 && u.totalResponseMs ? Math.round(u.totalResponseMs / info.turns) : 0;
  const lastResponseMs = u.lastResponseMs || 0;
  const fastestMs = u.fastestResponseMs || 0;

  const lines = [
    "<b>🦅 Talon</b>",
    "",
    `🧠 <b>Model:</b> <code>${escapeHtml(config.model)}</code>`,
    `📚 <b>Context:</b> ${formatTokenCount(contextUsed)}/${formatTokenCount(contextMax)} (${contextPct}%)`,
    `<code>${contextBar}</code>`,
    "",
    `🧮 <b>Session usage</b>`,
    `   Input: ${formatTokenCount(u.totalInputTokens)} tokens`,
    `   Output: ${formatTokenCount(u.totalOutputTokens)} tokens`,
    `   Cache read: ${formatTokenCount(u.totalCacheRead)} (${cacheHitPct}% hit)`,
    `   Cache write: ${formatTokenCount(u.totalCacheWrite)}`,
    `   Est. cost: $${u.estimatedCostUsd.toFixed(4)}`,
    "",
    `⏱️ <b>Response time</b>`,
    `   Last: ${lastResponseMs ? formatDuration(lastResponseMs) : "—"}`,
    `   Average: ${avgResponseMs ? formatDuration(avgResponseMs) : "—"}`,
    `   Fastest: ${fastestMs ? formatDuration(fastestMs) : "—"}`,
    "",
    `🧵 <b>Session:</b> ${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "…</code>" : "<i>(new)</i>"}`,
    `   Turns: ${info.turns} · Age: ${sessionAge}`,
    `   Last active: ${lastSeen}`,
    "",
    `⚙️ Active sessions: ${getActiveSessionCount()} · Uptime: ${uptime}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// ── Shared utilities ─────────────────────────────────────────────────────────

function shouldHandleInGroup(ctx: {
  chat: { type: string };
  me: { id: number; username?: string };
  message?: {
    text?: string;
    caption?: string;
    reply_to_message?: { from?: { id: number } };
  };
}): boolean {
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return true;
  const text = ctx.message?.text || ctx.message?.caption || "";
  const botUser = ctx.me.username;
  const mentioned =
    botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
  const repliedToBot =
    ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  return !!(mentioned || repliedToBot);
}

function getSenderName(
  from: { first_name?: string; last_name?: string } | undefined,
): string {
  return (
    [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "User"
  );
}

function getReplyContext(
  replyMsg:
    | {
        from?: { id: number; first_name?: string; last_name?: string };
        text?: string;
        caption?: string;
      }
    | undefined,
  botId: number,
): string {
  if (!replyMsg || replyMsg.from?.id === botId) return "";
  const text = replyMsg.text || replyMsg.caption || "";
  if (!text) return "";
  const author = [replyMsg.from?.first_name, replyMsg.from?.last_name]
    .filter(Boolean)
    .join(" ");
  return `[Replying to ${author}: "${text.slice(0, 500)}"]\n\n`;
}

function getForwardContext(msg: {
  forward_origin?: {
    type: string;
    sender_user?: { first_name?: string; last_name?: string };
    sender_user_name?: string;
    chat?: { title?: string };
  };
}): string {
  const origin = msg.forward_origin;
  if (!origin) return "";
  let from = "someone";
  if (origin.type === "user" && origin.sender_user) {
    from = [origin.sender_user.first_name, origin.sender_user.last_name]
      .filter(Boolean)
      .join(" ");
  } else if (origin.type === "hidden_user" && origin.sender_user_name) {
    from = origin.sender_user_name;
  } else if (
    (origin.type === "channel" || origin.type === "chat") &&
    origin.chat
  ) {
    from = origin.chat.title || "a chat";
  }
  return `[Forwarded from ${from}]\n`;
}

async function downloadTelegramFile(
  fileId: string,
  fileName: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Could not get file path from Telegram");

  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const uploadsDir = resolve(config.workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  writeFileSync(destPath, buffer);
  return destPath;
}

// ── Response delivery ────────────────────────────────────────────────────────

const SKIP_DIRS = ["/uploads/", "/.claude/", "/node_modules/"];
const SKIP_NAMES = new Set(["sessions.json"]);

async function sendNewFiles(
  chatId: number,
  filePaths: string[],
): Promise<void> {
  for (const filePath of filePaths) {
    const name = basename(filePath);
    if (SKIP_NAMES.has(name)) continue;
    if (name.startsWith(".")) continue;
    if (SKIP_DIRS.some((d) => filePath.includes(d))) continue;

    try {
      const stat = statSync(filePath);
      if (stat.size > 49 * 1024 * 1024 || stat.size === 0) continue;

      console.log(`[file] Sending ${name} (${stat.size} bytes)`);
      await bot.api.sendDocument(chatId, new InputFile(readFileSync(filePath), name));
    } catch (err) {
      console.error(`[file] Failed to send ${name}:`, err);
    }
  }
}

async function sendHtml(
  chatId: number,
  html: string,
  replyToId?: number,
): Promise<number> {
  const params = {
    parse_mode: "HTML" as const,
    reply_parameters: replyToId ? { message_id: replyToId } : undefined,
  };
  try {
    const sent = await bot.api.sendMessage(chatId, html, params);
    return sent.message_id;
  } catch {
    const plain = html.replace(/<[^>]+>/g, "");
    const sent = await bot.api.sendMessage(chatId, plain, {
      reply_parameters: replyToId ? { message_id: replyToId } : undefined,
    });
    return sent.message_id;
  }
}

/**
 * Run the agent and deliver responses with streaming + multi-message support.
 *
 * Flow:
 * 1. If Claude outputs text then uses a tool, the text is sent immediately
 *    as a progress message (via onTextBlock callback).
 * 2. While text streams, the message is edited in real-time (~1/sec).
 * 3. The final text block is sent/edited as the last message.
 * 4. Any workspace files created during the turn are sent as attachments.
 */
async function processAndReply(
  chatId: string | number,
  numericChatId: number,
  replyToId: number,
  messageId: number,
  prompt: string,
  senderName: string,
  isGroup: boolean,
  senderUsername?: string,
): Promise<void> {
  // Set bridge context so MCP tools can call Telegram actions in this chat
  setBridgeContext(numericChatId, bot, InputFile);

  // Auto-manage typing indicator: send immediately and keep alive every 4s
  await bot.api.sendChatAction(numericChatId, "typing").catch(() => {});
  const typingTimer = setInterval(() => {
    bot.api.sendChatAction(numericChatId, "typing").catch(() => {});
  }, 4000);

  let streamMsgId: number | undefined;
  let lastEditedText = "";
  let streamStarted = false;

  const streamTimer = setTimeout(() => {
    streamStarted = true;
  }, 2000);

  const onStreamDelta = async (accumulated: string) => {
    if (!streamStarted) return;
    try {
      const display =
        accumulated.length > 3900
          ? accumulated.slice(0, 3900) + "…"
          : accumulated;

      if (!streamMsgId) {
        const html = markdownToTelegramHtml(display + " ▍");
        try {
          const sent = await bot.api.sendMessage(numericChatId, html, {
            parse_mode: "HTML",
            reply_parameters: { message_id: replyToId },
          });
          streamMsgId = sent.message_id;
        } catch {
          const sent = await bot.api.sendMessage(numericChatId, display + " ▍", {
            reply_parameters: { message_id: replyToId },
          });
          streamMsgId = sent.message_id;
        }
        lastEditedText = display;
      } else if (display.length - lastEditedText.length >= 60) {
        const html = markdownToTelegramHtml(display + " ▍");
        try {
          await bot.api.editMessageText(numericChatId, streamMsgId, html, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(
              numericChatId,
              streamMsgId,
              display + " ▍",
            );
          } catch {
            // Rate limited, skip
          }
        }
        lastEditedText = display;
      }
    } catch {
      // Non-critical
    }
  };

  // Multi-message: send intermediate text blocks immediately
  const onTextBlock = async (text: string) => {
    // If we have a streaming message, edit it with the final block text
    if (streamMsgId) {
      const html = markdownToTelegramHtml(text);
      try {
        await bot.api.editMessageText(numericChatId, streamMsgId, html, {
          parse_mode: "HTML",
        });
      } catch {
        try {
          await bot.api.editMessageText(numericChatId, streamMsgId, text);
        } catch {
          // ignore
        }
      }
      streamMsgId = undefined;
      lastEditedText = "";
    } else {
      // Send as a new message
      await sendHtml(numericChatId, markdownToTelegramHtml(text), replyToId);
    }
  };

  // In DMs, prepend user metadata so Claude knows who it's talking to
  let enrichedPrompt = prompt;
  if (!isGroup && senderName) {
    const userTag = senderUsername ? ` (@${senderUsername})` : "";
    enrichedPrompt = `[DM from ${senderName}${userTag}]\n${prompt}`;
  }

  const result = await handleMessage({
    chatId: String(chatId),
    text: enrichedPrompt,
    senderName,
    isGroup,
    messageId,
    onTextBlock,
    onStreamDelta,
  });

  clearTimeout(streamTimer);
  clearInterval(typingTimer);

  const bridgeSent = getBridgeMessageCount();

  // If Claude sent messages via MCP tools, don't duplicate with text output.
  // Only send final text if no bridge messages were sent.
  if (bridgeSent === 0) {
    const finalText = result.text;
    if (finalText) {
      if (streamMsgId) {
        const chunks = splitMessage(finalText, config.maxMessageLength);
        const firstHtml = markdownToTelegramHtml(chunks[0]);
        try {
          await bot.api.editMessageText(numericChatId, streamMsgId, firstHtml, {
            parse_mode: "HTML",
          });
        } catch {
          try {
            await bot.api.editMessageText(numericChatId, streamMsgId, chunks[0]);
          } catch {
            // ignore
          }
        }
        for (let i = 1; i < chunks.length; i++) {
          await sendHtml(numericChatId, markdownToTelegramHtml(chunks[i]), replyToId);
        }
      } else {
        const chunks = splitMessage(finalText, config.maxMessageLength);
        for (const chunk of chunks) {
          await sendHtml(numericChatId, markdownToTelegramHtml(chunk), replyToId);
        }
      }
    } else if (!streamMsgId) {
      await sendHtml(numericChatId, "<i>(no response)</i>", replyToId);
    }
  } else if (streamMsgId) {
    // Clean up streaming placeholder if bridge handled delivery
    try {
      await bot.api.deleteMessage(numericChatId, streamMsgId);
    } catch {
      // ignore
    }
  }

  clearBridgeContext();

  // Send new files (only if not already sent via bridge tools)
  if (bridgeSent === 0) {
    await sendNewFiles(numericChatId, result.newFiles);
  }
}

// ── History capture (runs for ALL messages, before handlers) ─────────────────

bot.on("message", (ctx, next) => {
  const chatId = String(ctx.chat.id);
  const sender = getSenderName(ctx.from);
  const senderId = ctx.from?.id ?? 0;
  const msgId = ctx.message.message_id;
  const replyToMsgId = ctx.message.reply_to_message?.message_id;

  // Register this chat as allowed for userbot access (scope guard)
  allowChat(ctx.chat.id);
  const timestamp = ctx.message.date * 1000;

  if ("text" in ctx.message && ctx.message.text) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.text, replyToMsgId, timestamp });
  } else if ("photo" in ctx.message && ctx.message.photo) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || "(photo)", replyToMsgId, timestamp, mediaType: "photo" });
  } else if ("document" in ctx.message && ctx.message.document) {
    const name = ctx.message.document.file_name || "file";
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || `(sent ${name})`, replyToMsgId, timestamp, mediaType: "document" });
  } else if ("voice" in ctx.message && ctx.message.voice) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: "(voice message)", replyToMsgId, timestamp, mediaType: "voice" });
  } else if ("sticker" in ctx.message && ctx.message.sticker) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.sticker.emoji || "(sticker)", replyToMsgId, timestamp, mediaType: "sticker", stickerFileId: ctx.message.sticker.file_id });
  } else if ("video" in ctx.message && ctx.message.video) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || "(video)", replyToMsgId, timestamp, mediaType: "video" });
  } else if ("animation" in ctx.message && ctx.message.animation) {
    pushMessage(chatId, { msgId, senderId, senderName: sender, text: ctx.message.caption || "(GIF)", replyToMsgId, timestamp, mediaType: "animation" });
  }

  return next();
});

// ── Message handlers ─────────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );
    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const prompt = fwdCtx + replyCtx + ctx.message.text;

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

bot.on("message:photo", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const bestPhoto = ctx.message.photo[ctx.message.photo.length - 1];
    const savedPath = await downloadTelegramFile(
      bestPhoto.file_id,
      `photo_${bestPhoto.file_unique_id}.jpg`,
    );

    const caption = ctx.message.caption || "";
    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const prompt = [
      fwdCtx,
      replyCtx,
      `User sent a photo saved to: ${savedPath}`,
      `Read and analyze this image file.`,
      caption ? `Caption: ${caption}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Photo error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

bot.on("message:document", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const doc = ctx.message.document;
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await sendHtml(
        ctx.chat.id,
        "File too large (max 20MB).",
        ctx.message.message_id,
      );
      return;
    }

    const fileName = doc.file_name || `doc_${doc.file_unique_id}`;
    const savedPath = await downloadTelegramFile(doc.file_id, fileName);

    const caption = ctx.message.caption || "";
    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const prompt = [
      fwdCtx,
      replyCtx,
      `User sent a document: "${fileName}" (${doc.mime_type || "unknown"}).`,
      `Saved to: ${savedPath}`,
      `Read and process this file.`,
      caption ? `Caption: ${caption}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Doc error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

bot.on("message:voice", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const savedPath = await downloadTelegramFile(
      ctx.message.voice.file_id,
      `voice_${ctx.message.voice.file_unique_id}.ogg`,
    );

    const prompt = [
      `User sent a voice message (${ctx.message.voice.duration}s).`,
      `Audio file saved to: ${savedPath}`,
    ].join("\n");

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Voice error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

bot.on("message:sticker", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const sticker = ctx.message.sticker;
    const emoji = sticker.emoji || "";
    const setName = sticker.set_name || "";

    const prompt = [
      `User sent a sticker: ${emoji}`,
      `Sticker file_id: ${sticker.file_id}`,
      setName ? `Sticker set: ${setName}` : "",
      sticker.is_animated ? "(animated)" : sticker.is_video ? "(video sticker)" : "",
      "You can send this sticker back using the send_sticker tool with the file_id above.",
    ]
      .filter(Boolean)
      .join("\n");

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Sticker error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

bot.on("message:video", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const video = ctx.message.video;
    const fileName = video.file_name || `video_${video.file_unique_id}.mp4`;
    const savedPath = await downloadTelegramFile(video.file_id, fileName);

    const caption = ctx.message.caption || "";
    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const prompt = [
      fwdCtx,
      replyCtx,
      `User sent a video: "${fileName}" (${video.duration}s, ${video.width}x${video.height}).`,
      `Saved to: ${savedPath}`,
      caption ? `Caption: ${caption}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Video error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

bot.on("message:animation", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const senderUsername = ctx.from?.username;

  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    const anim = ctx.message.animation;
    const fileName = anim.file_name || `animation_${anim.file_unique_id}.mp4`;
    const savedPath = await downloadTelegramFile(anim.file_id, fileName);

    const caption = ctx.message.caption || "";
    const fwdCtx = getForwardContext(
      ctx.message as Parameters<typeof getForwardContext>[0],
    );
    const replyCtx = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const prompt = [
      fwdCtx,
      replyCtx,
      `User sent a GIF/animation: "${fileName}" (${anim.duration}s).`,
      `Saved to: ${savedPath}`,
      caption ? `Caption: ${caption}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await processAndReply(
      chatId,
      ctx.chat.id,
      ctx.message.message_id,
      ctx.message.message_id,
      prompt,
      sender,
      isGroup,
      senderUsername,
    );
  } catch (err) {
    console.error(`[${chatId}] Animation error:`, err instanceof Error ? err.message : err);
    await sendHtml(
      ctx.chat.id,
      escapeHtml(friendlyError(err instanceof Error ? err : new Error(String(err)))),
      ctx.message.message_id,
    );
  } finally {
    clearInterval(typing);
  }
});

// ── Callback query handler (inline keyboard buttons) ─────────────────────────

bot.on("callback_query:data", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? ctx.from.id);
  const numericChatId = ctx.chat?.id ?? ctx.from.id;
  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const sender = getSenderName(ctx.from);
  const callbackData = ctx.callbackQuery.data;

  // Acknowledge the callback immediately
  await ctx.answerCallbackQuery().catch(() => {});

  const typing = setInterval(() => {
    bot.api.sendChatAction(numericChatId, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(numericChatId, "typing").catch(() => {});

  try {
    const prompt = `[Button pressed] User clicked inline button with callback data: "${callbackData}"`;
    const replyToId = ctx.callbackQuery.message?.message_id ?? 0;

    await processAndReply(
      chatId,
      numericChatId,
      replyToId,
      replyToId,
      prompt,
      sender,
      isGroup,
    );
  } catch (err) {
    console.error(`[${chatId}] Callback error:`, err instanceof Error ? err.message : err);
  } finally {
    clearInterval(typing);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received, shutting down gracefully...`);
  try {
    // Stop accepting new messages
    await bot.stop();
    console.log("[shutdown] Bot disconnected");
  } catch (err) {
    console.error("[shutdown] Bot stop error:", err instanceof Error ? err.message : err);
  }
  try {
    await stopBridge();
    console.log("[shutdown] Bridge stopped");
  } catch (err) {
    console.error("[shutdown] Bridge stop error:", err instanceof Error ? err.message : err);
  }
  flushSessions();
  console.log("[shutdown] Sessions saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  flushSessions();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[warning] Unhandled rejection:", reason instanceof Error ? reason.message : reason);
  // Don't exit — log and continue
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const bridgePort = await startBridge(19876);
  console.log(`Starting Talon... (bridge port: ${bridgePort})`);
  bot.catch((err) => {
    console.error("Bot error:", err.message ?? err);
  });
  await bot.start({
    onStart: (info) => console.log(`Talon running as @${info.username}`),
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
