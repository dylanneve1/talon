import { Bot, InputFile } from "grammy";
import { initAgent, handleMessage } from "./agent.js";
import { loadConfig } from "./config.js";
import { loadSessions, resetSession, getSessionInfo, getActiveSessionCount } from "./sessions.js";
import { splitMessage, markdownToTelegramHtml, friendlyError } from "./telegram.js";
import { writeFileSync, readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename, extname } from "node:path";

// -- Bootstrap ----------------------------------------------------------------

const config = loadConfig();
loadSessions();
initAgent(config);

const bot = new Bot(config.botToken);

// Ensure workspace directory exists
if (!existsSync(config.workspace)) {
  mkdirSync(config.workspace, { recursive: true });
}

// -- Commands -----------------------------------------------------------------

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
    "<b>Talon</b>",
    `Model: <code>${escapeHtml(config.model)}</code>`,
    `Session: ${info.sessionId ? "<code>" + escapeHtml(info.sessionId.slice(0, 8)) + "...</code>" : "<i>(new)</i>"}`,
    `Turns: ${info.turns}`,
    `Active sessions: ${getActiveSessionCount()}`,
    `Uptime: ${uptime}`,
  ];
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

// -- Shared handler logic -----------------------------------------------------

/** Check if this message should be handled in a group chat. */
function shouldHandleInGroup(
  ctx: { chat: { type: string }; me: { id: number; username?: string }; message?: { text?: string; caption?: string; reply_to_message?: { from?: { id: number } } } },
): boolean {
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  if (!isGroup) return true;
  const text = ctx.message?.text || ctx.message?.caption || "";
  const botUser = ctx.me.username;
  const mentioned = botUser && text.toLowerCase().includes(`@${botUser.toLowerCase()}`);
  const repliedToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  return !!(mentioned || repliedToBot);
}

/** Extract sender display name. */
function getSenderName(from: { first_name?: string; last_name?: string } | undefined): string {
  return [from?.first_name, from?.last_name].filter(Boolean).join(" ") || "User";
}

/** Build reply context prefix if replying to another user's message. */
function getReplyContext(
  replyMsg: { from?: { id: number; first_name?: string; last_name?: string }; text?: string; caption?: string } | undefined,
  botId: number,
): string {
  if (!replyMsg || replyMsg.from?.id === botId) return "";
  const text = replyMsg.text || replyMsg.caption || "";
  if (!text) return "";
  const author = [replyMsg.from?.first_name, replyMsg.from?.last_name].filter(Boolean).join(" ");
  return `[Replying to ${author}: "${text.slice(0, 500)}"]\n\n`;
}

/** Build forwarded message context prefix. */
function getForwardContext(
  msg: { forward_origin?: { type: string; sender_user?: { first_name?: string; last_name?: string }; sender_user_name?: string; chat?: { title?: string } } },
): string {
  const origin = msg.forward_origin;
  if (!origin) return "";

  let from = "someone";
  if (origin.type === "user" && origin.sender_user) {
    from = [origin.sender_user.first_name, origin.sender_user.last_name].filter(Boolean).join(" ");
  } else if (origin.type === "hidden_user" && origin.sender_user_name) {
    from = origin.sender_user_name;
  } else if ((origin.type === "channel" || origin.type === "chat") && origin.chat) {
    from = origin.chat.title || "a chat";
  }

  return `[Forwarded from ${from}]\n`;
}

/**
 * Download a file from Telegram and save it to the workspace.
 * Returns the absolute path to the saved file.
 */
async function downloadTelegramFile(
  fileId: string,
  fileName: string,
): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error("Could not get file path from Telegram");

  const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download file: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());

  // Ensure uploads directory exists
  const uploadsDir = resolve(config.workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  // Use timestamp prefix to avoid collisions
  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  writeFileSync(destPath, buffer);

  return destPath;
}

/**
 * Send a response with streaming message edits.
 * Sends an initial placeholder, then edits it as text accumulates.
 * Falls back to a single reply if the response comes quickly.
 */
async function sendStreamingResponse(
  ctx: { chat: { id: number }; message?: { message_id: number } },
  params: {
    chatId: string;
    prompt: string;
    senderName: string;
    isGroup: boolean;
  },
): Promise<void> {
  const messageId = ctx.message?.message_id;
  let sentMsgId: number | undefined;
  let lastEditedText = "";
  let streamStarted = false;
  const EDIT_MIN_DIFF = 80; // Only edit if text changed by at least this many chars

  // Timer to detect slow responses and trigger streaming
  const streamTimeout = setTimeout(() => {
    streamStarted = true;
  }, 2000);

  const onStreamUpdate = async (accumulatedText: string) => {
    if (!streamStarted) return;

    try {
      const displayText = accumulatedText.length > 3900
        ? accumulatedText.slice(0, 3900) + "..."
        : accumulatedText;

      if (!sentMsgId) {
        // Send the initial message
        const html = markdownToTelegramHtml(displayText + " ...");
        try {
          const sent = await bot.api.sendMessage(ctx.chat.id, html, {
            parse_mode: "HTML",
            reply_parameters: messageId ? { message_id: messageId } : undefined,
          });
          sentMsgId = sent.message_id;
          lastEditedText = displayText;
        } catch {
          // If HTML fails, try plain text
          const sent = await bot.api.sendMessage(ctx.chat.id, displayText + " ...", {
            reply_parameters: messageId ? { message_id: messageId } : undefined,
          });
          sentMsgId = sent.message_id;
          lastEditedText = displayText;
        }
      } else if (displayText.length - lastEditedText.length >= EDIT_MIN_DIFF) {
        // Edit the existing message
        const html = markdownToTelegramHtml(displayText + " ...");
        try {
          await bot.api.editMessageText(ctx.chat.id, sentMsgId, html, { parse_mode: "HTML" });
        } catch {
          try {
            await bot.api.editMessageText(ctx.chat.id, sentMsgId, displayText + " ...");
          } catch {
            // Rate limited or message unchanged, skip
          }
        }
        lastEditedText = displayText;
      }
    } catch {
      // Non-critical streaming error, continue
    }
  };

  const result = await handleMessage({
    chatId: params.chatId,
    text: params.prompt,
    senderName: params.senderName,
    isGroup: params.isGroup,
    onStreamUpdate,
  });

  clearTimeout(streamTimeout);

  if (!result.text) {
    if (sentMsgId) {
      try {
        await bot.api.editMessageText(ctx.chat.id, sentMsgId, "<i>(no response)</i>", { parse_mode: "HTML" });
      } catch {
        await bot.api.editMessageText(ctx.chat.id, sentMsgId, "(no response)");
      }
    } else {
      await sendHtml(ctx.chat.id, "<i>(no response)</i>", messageId);
    }
    return;
  }

  // Final response: either edit the streaming message or send fresh
  if (sentMsgId) {
    // Edit the streamed message with final content
    const chunks = splitMessage(result.text, config.maxMessageLength);
    // Edit the first chunk into the existing message
    const firstHtml = markdownToTelegramHtml(chunks[0]);
    try {
      await bot.api.editMessageText(ctx.chat.id, sentMsgId, firstHtml, { parse_mode: "HTML" });
    } catch {
      try {
        await bot.api.editMessageText(ctx.chat.id, sentMsgId, chunks[0]);
      } catch {
        // Message might be identical, that's fine
      }
    }
    // Send remaining chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      await sendHtml(ctx.chat.id, markdownToTelegramHtml(chunks[i]), messageId);
    }
  } else {
    // No streaming happened, send normally
    const chunks = splitMessage(result.text, config.maxMessageLength);
    for (const chunk of chunks) {
      await sendHtml(ctx.chat.id, markdownToTelegramHtml(chunk), messageId);
    }
  }

  // Send any new files created during the turn
  await sendNewFiles(ctx.chat.id, result.newFiles);
}

/**
 * Send text as HTML with fallback to plain text.
 */
async function sendHtml(chatId: number, html: string, replyToId?: number): Promise<void> {
  const params = {
    parse_mode: "HTML" as const,
    reply_parameters: replyToId ? { message_id: replyToId } : undefined,
  };
  try {
    await bot.api.sendMessage(chatId, html, params);
  } catch {
    // HTML parse failed, strip tags and send plain
    const plain = html.replace(/<[^>]+>/g, "");
    await bot.api.sendMessage(chatId, plain, {
      reply_parameters: replyToId ? { message_id: replyToId } : undefined,
    });
  }
}

/**
 * Send new/modified workspace files as Telegram documents.
 */
async function sendNewFiles(chatId: number, filePaths: string[]): Promise<void> {
  // Common file extensions we should send back
  const sendableExtensions = new Set([
    ".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".xml", ".yaml", ".yml",
    ".html", ".css", ".sh", ".bash", ".sql", ".rb", ".go", ".rs", ".java", ".c",
    ".cpp", ".h", ".hpp", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    ".zip", ".tar", ".gz", ".log", ".cfg", ".ini", ".toml", ".env.example",
  ]);

  for (const filePath of filePaths) {
    const ext = extname(filePath).toLowerCase();
    const name = basename(filePath);

    // Skip non-sendable files, very large files (>50MB Telegram limit), and uploads (those are inputs)
    if (!sendableExtensions.has(ext)) continue;
    if (filePath.includes("/uploads/")) continue;

    try {
      const stat = statSync(filePath);
      if (stat.size > 49 * 1024 * 1024) continue; // Skip files >49MB
      if (stat.size === 0) continue;

      const fileData = readFileSync(filePath);
      await bot.api.sendDocument(chatId, new InputFile(fileData, name));
    } catch (err) {
      console.error(`Failed to send file ${name}:`, err);
    }
  }
}

// -- Message handlers ---------------------------------------------------------

// Text messages
bot.on("message:text", async (ctx) => {
  if (!shouldHandleInGroup(ctx)) return;

  const chatId = String(ctx.chat.id);
  const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
  const sender = getSenderName(ctx.from);

  // Typing indicator
  const typing = setInterval(() => {
    bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});
  }, 4000);
  await bot.api.sendChatAction(ctx.chat.id, "typing").catch(() => {});

  try {
    // Build prompt with reply context and forward info
    const replyContext = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );
    const forwardContext = getForwardContext(ctx.message as Parameters<typeof getForwardContext>[0]);
    const prompt = forwardContext + replyContext + ctx.message.text;

    await sendStreamingResponse(ctx, { chatId, prompt, senderName: sender, isGroup });
  } catch (err) {
    const errMsg = err instanceof Error ? err : String(err);
    console.error(`[${chatId}] Error:`, errMsg);
    await sendHtml(ctx.chat.id, escapeHtml(friendlyError(errMsg instanceof Error ? errMsg : new Error(String(errMsg)))), ctx.message.message_id);
  } finally {
    clearInterval(typing);
  }
});

// Photo messages
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
    // Get highest resolution photo (last in array)
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];

    // Download and save the photo
    const savedPath = await downloadTelegramFile(bestPhoto.file_id, `photo_${bestPhoto.file_unique_id}.jpg`);

    // Build prompt: include caption if present, reference the image file
    const caption = ctx.message.caption || "";
    const forwardContext = getForwardContext(ctx.message as Parameters<typeof getForwardContext>[0]);
    const replyContext = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const prompt = [
      forwardContext,
      replyContext,
      `User sent a photo. The image has been saved to: ${savedPath}`,
      `Please read and analyze this image file using the Read tool.`,
      caption ? `Caption: ${caption}` : "",
    ].filter(Boolean).join("\n");

    await sendStreamingResponse(ctx, { chatId, prompt, senderName: sender, isGroup });
  } catch (err) {
    const errMsg = err instanceof Error ? err : String(err);
    console.error(`[${chatId}] Photo error:`, errMsg);
    await sendHtml(ctx.chat.id, escapeHtml(friendlyError(errMsg instanceof Error ? errMsg : new Error(String(errMsg)))), ctx.message.message_id);
  } finally {
    clearInterval(typing);
  }
});

// Document messages
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
    const fileName = doc.file_name || `document_${doc.file_unique_id}`;
    const mimeType = doc.mime_type || "application/octet-stream";

    // Check file size (Telegram bot API limit: 20MB for downloads)
    if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
      await sendHtml(ctx.chat.id, "File is too large (max 20MB for downloads).", ctx.message.message_id);
      return;
    }

    const savedPath = await downloadTelegramFile(doc.file_id, fileName);

    const caption = ctx.message.caption || "";
    const forwardContext = getForwardContext(ctx.message as Parameters<typeof getForwardContext>[0]);
    const replyContext = getReplyContext(
      ctx.message.reply_to_message as Parameters<typeof getReplyContext>[0],
      ctx.me.id,
    );

    const prompt = [
      forwardContext,
      replyContext,
      `User sent a document: "${fileName}" (${mimeType}).`,
      `The file has been saved to: ${savedPath}`,
      `You can read and process this file using the Read tool.`,
      caption ? `Caption: ${caption}` : "",
    ].filter(Boolean).join("\n");

    await sendStreamingResponse(ctx, { chatId, prompt, senderName: sender, isGroup });
  } catch (err) {
    const errMsg = err instanceof Error ? err : String(err);
    console.error(`[${chatId}] Document error:`, errMsg);
    await sendHtml(ctx.chat.id, escapeHtml(friendlyError(errMsg instanceof Error ? errMsg : new Error(String(errMsg)))), ctx.message.message_id);
  } finally {
    clearInterval(typing);
  }
});

// Voice messages
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
    const voice = ctx.message.voice;
    const duration = voice.duration;
    const savedPath = await downloadTelegramFile(voice.file_id, `voice_${voice.file_unique_id}.ogg`);

    const prompt = [
      `User sent a voice message (${duration}s, OGG format).`,
      `The audio file has been saved to: ${savedPath}`,
      `Please acknowledge that a voice message was received. You can reference the file if needed.`,
    ].join("\n");

    await sendStreamingResponse(ctx, { chatId, prompt, senderName: sender, isGroup });
  } catch (err) {
    const errMsg = err instanceof Error ? err : String(err);
    console.error(`[${chatId}] Voice error:`, errMsg);
    await sendHtml(ctx.chat.id, escapeHtml(friendlyError(errMsg instanceof Error ? errMsg : new Error(String(errMsg)))), ctx.message.message_id);
  } finally {
    clearInterval(typing);
  }
});

// -- Helpers ------------------------------------------------------------------

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

// -- Start --------------------------------------------------------------------

console.log("Starting Talon...");
bot.catch((err) => {
  console.error("Bot error:", err.message ?? err);
});
bot.start({
  onStart: (info) => console.log(`Talon running as @${info.username}`),
});
