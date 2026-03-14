import { Bot, InputFile } from "grammy";
import { initAgent, handleMessage } from "./agent.js";
import { loadConfig } from "./config.js";
import {
  loadSessions,
  resetSession,
  getSessionInfo,
  getActiveSessionCount,
} from "./sessions.js";
import { splitMessage, markdownToTelegramHtml, friendlyError } from "./telegram.js";
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

// ── Commands ─────────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply("Talon here. Send a message or mention me in a group."),
);

bot.command("reset", async (ctx) => {
  resetSession(String(ctx.chat.id));
  await ctx.reply("Session cleared.");
});

bot.command("status", async (ctx) => {
  const info = getSessionInfo(String(ctx.chat.id));
  const uptime = formatDuration(process.uptime() * 1000);
  const lines = [
    "<b>🦅 Talon</b>",
    `Model: <code>${escapeHtml(config.model)}</code>`,
    `Session: ${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "…</code>" : "<i>(new)</i>"}`,
    `Turns: ${info.turns}`,
    `Active sessions: ${getActiveSessionCount()}`,
    `Uptime: ${uptime}`,
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
  chatId: number,
  numericChatId: number,
  replyToId: number,
  prompt: string,
  senderName: string,
  isGroup: boolean,
): Promise<void> {
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

  const result = await handleMessage({
    chatId,
    text: prompt,
    senderName,
    isGroup,
    onTextBlock,
    onStreamDelta,
  });

  clearTimeout(streamTimer);

  // Send the final text (whatever wasn't already sent via onTextBlock)
  const finalText = result.text;
  if (finalText) {
    if (streamMsgId) {
      // Edit the streaming message with final content
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
        await sendHtml(
          numericChatId,
          markdownToTelegramHtml(chunks[i]),
          replyToId,
        );
      }
    } else {
      const chunks = splitMessage(finalText, config.maxMessageLength);
      for (const chunk of chunks) {
        await sendHtml(
          numericChatId,
          markdownToTelegramHtml(chunk),
          replyToId,
        );
      }
    }
  } else if (!streamMsgId) {
    await sendHtml(numericChatId, "<i>(no response)</i>", replyToId);
  }

  // Send new files
  await sendNewFiles(numericChatId, result.newFiles);
}

// ── Message handlers ─────────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);

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
      prompt,
      sender,
      isGroup,
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
      prompt,
      sender,
      isGroup,
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
      prompt,
      sender,
      isGroup,
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
      prompt,
      sender,
      isGroup,
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

// ── Start ────────────────────────────────────────────────────────────────────

console.log("Starting Talon...");
bot.catch((err) => {
  console.error("Bot error:", err.message ?? err);
});
bot.start({
  onStart: (info) => console.log(`Talon running as @${info.username}`),
});
