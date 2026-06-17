/**
 * Message-context helpers — sender name, reply context, attachment download +
 * classification, and the chunked sender used by both replies and tool calls.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Message, Attachment, TextBasedChannel } from "discord.js";
import {
  splitMessage,
  suppressMentions,
  DISCORD_MAX_TEXT,
} from "../formatting.js";

export function getSenderName(msg: Message): string {
  return (
    (msg.member?.displayName || msg.author.globalName || msg.author.username) ??
    "User"
  );
}

export function buildReplyContext(
  msg: Message,
  botId: string | undefined,
): string {
  const ref = msg.reference;
  if (!ref || !ref.messageId) return "";
  // We don't always have the message cached. Discord.js provides
  // msg.fetchReference() but that's async; we keep this synchronous and rely
  // on the partial info already available via mentions.repliedUser.
  const replied = msg.mentions.repliedUser;
  if (!replied) return `[Replying to msg_id:${ref.messageId}]\n\n`;
  const author =
    replied.id === botId
      ? "bot"
      : replied.globalName || replied.username || "User";
  return `[Replying to ${author} msg_id:${ref.messageId}]\n\n`;
}

// ── Attachment download ──────────────────────────────────────────────────────

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

export async function downloadAttachment(
  attachment: Attachment,
  workspace: string,
): Promise<string> {
  if (attachment.size && attachment.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `File too large (${Math.round(attachment.size / 1024 / 1024)}MB, max ${ATTACHMENT_MAX_BYTES / 1024 / 1024}MB).`,
    );
  }
  const resp = await fetch(attachment.url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length === 0) throw new Error("Downloaded file is empty.");

  const safeName = (attachment.name || `att_${attachment.id}`).replace(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const uploadsDir = resolve(workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const dest = resolve(uploadsDir, `${Date.now()}-${safeName}`);
  writeFileSync(dest, buffer);
  return dest;
}

export function classifyAttachment(att: Attachment): {
  type: "photo" | "document" | "voice" | "video" | "audio" | "animation";
  promptLines: (savedPath: string) => string[];
} {
  const ct = att.contentType ?? "";
  const name = (att.name ?? "").toLowerCase();

  if (ct.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/.test(name)) {
    if (ct === "image/gif" || name.endsWith(".gif")) {
      return {
        type: "animation",
        promptLines: (p) => [
          `User sent a GIF: "${att.name ?? att.id}".`,
          `Saved to: ${p}`,
        ],
      };
    }
    return {
      type: "photo",
      promptLines: (p) => [
        `User sent an image saved to: ${p}`,
        "Read this file to view it. If you need to reference this image in future turns, re-read the file — image data does not persist between turns.",
      ],
    };
  }
  if (ct.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/.test(name)) {
    return {
      type: "video",
      promptLines: (p) => [
        `User sent a video: "${att.name ?? att.id}".`,
        `Saved to: ${p}`,
      ],
    };
  }
  if (
    ct === "audio/ogg" ||
    /voice/.test(name) ||
    (att.waveform != null && ct.startsWith("audio/"))
  ) {
    return {
      type: "voice",
      promptLines: (p) => [
        `User sent a voice message (${att.duration ?? "?"}s).`,
        `Audio saved to: ${p}. You cannot transcribe audio — acknowledge it and respond based on context.`,
      ],
    };
  }
  if (ct.startsWith("audio/") || /\.(mp3|wav|flac|m4a|opus)$/.test(name)) {
    return {
      type: "audio",
      promptLines: (p) => [
        `User sent an audio file: "${att.name ?? att.id}".`,
        `Saved to: ${p}`,
      ],
    };
  }
  return {
    type: "document",
    promptLines: (p) => [
      `User sent a document: "${att.name ?? att.id}" (${ct || "unknown"}).`,
      `Saved to: ${p}`,
      "Read and process this file.",
    ],
  };
}

// ── Send helpers ─────────────────────────────────────────────────────────────

export async function sendChunked(
  channel: TextBasedChannel,
  text: string,
  replyToId?: string,
): Promise<string[]> {
  const ids: string[] = [];
  if (!text.trim()) return ids;
  const chunks = splitMessage(suppressMentions(text), DISCORD_MAX_TEXT);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!channel.isSendable()) continue;
    // Let errors propagate so withRetry can classify + retry transient failures.
    // Previously we swallowed all errors here, making the outer withRetry dead code.
    const sent = await channel.send({
      content: chunk,
      allowedMentions: { parse: [] },
      reply:
        i === 0 && replyToId
          ? { messageReference: replyToId, failIfNotExists: false }
          : undefined,
    });
    ids.push(sent.id);
  }
  return ids;
}
