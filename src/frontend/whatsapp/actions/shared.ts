/**
 * Shared helpers for the WhatsApp action handlers: uniform error
 * capture, media-source resolution, quoted-reply resolution, and the
 * JID coercion the member-facing actions need.
 */

import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AnyMessageContent, WAMessage, WASocket } from "baileys";
import { expandFsPath } from "../../../util/fs-path.js";
import { log, logError } from "../../../util/log.js";
import type { ActionResult } from "../../../core/types.js";
import { toWhatsAppChunks } from "../formatting.js";
import { lookupMessage, rememberMessage } from "../message-store.js";
import type { WhatsAppChatInfo } from "../registry.js";

/** WhatsApp's own ceiling for a media upload. */
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/**
 * Run an action, converting a throw into a structured failure. WhatsApp
 * errors arrive as Boom objects whose message is the useful part; the
 * model gets that text so it can adapt rather than retry blindly.
 */
export async function tryAction(
  label: string,
  fn: () => Promise<ActionResult>,
): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("whatsapp", `${label} failed: ${msg}`);
    return { ok: false, error: `${label}: ${msg}` };
  }
}

/** Baileys accepts a Buffer, a stream, or `{ url }` for local paths and HTTP. */
export type MediaUpload = { url: string };

/**
 * Resolve one media input to something Baileys can upload. Two sources:
 * a public URL (WhatsApp's uploader fetches it) or a workspace file path
 * (streamed from disk). `file_id` is a Telegram concept with no WhatsApp
 * equivalent — say so instead of failing obscurely.
 */
export function resolveMediaUpload(
  src: { file_path?: unknown; url?: unknown; file_id?: unknown },
  label: string,
): { media: MediaUpload; fileName: string } | { error: string } {
  if (src.url) {
    const url = String(src.url);
    return {
      media: { url },
      fileName: basename(new URL(url).pathname) || "file",
    };
  }
  if (src.file_id) {
    return {
      error:
        `${label}: WhatsApp has no file_id — re-send by url (public) or ` +
        `file_path (workspace file)`,
    };
  }
  if (!src.file_path) {
    return {
      error: `${label}: provide file_path (workspace file) or url (public)`,
    };
  }
  const filePath = expandFsPath(String(src.file_path));
  if (!existsSync(filePath)) {
    return {
      error: `File not found: ${filePath} — check the workspace path, or send by url instead`,
    };
  }
  if (statSync(filePath).size > MAX_MEDIA_BYTES) {
    return { error: `${label}: file exceeds WhatsApp's 64MB limit` };
  }
  return { media: { url: filePath }, fileName: basename(filePath) };
}

/** Extension → mimetype for the document/audio paths that require one. */
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg; codecs=opus",
  ".wav": "audio/wav",
};

export function guessMimetype(fileName: string, fallback: string): string {
  return MIME_BY_EXT[extname(fileName).toLowerCase()] ?? fallback;
}

/**
 * Resolve a `reply_to` message id into the quoted message Baileys wants.
 * An unknown id quotes nothing rather than failing the send — the reply
 * link is a nicety, the message itself is the point.
 */
export function resolveQuoted(
  body: Record<string, unknown>,
  chatId: string,
): WAMessage | undefined {
  const raw = body.reply_to ?? body.reply_to_message_id;
  if (raw === undefined || raw === null) return undefined;
  const msgId = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(msgId)) return undefined;
  const stored = lookupMessage(msgId);
  if (!stored || stored.chatId !== chatId) return undefined;
  return (
    stored.message ?? {
      key: stored.key,
      message: { conversation: stored.text },
    }
  );
}

/**
 * Send one content payload, remember the resulting message so later
 * tool calls can address it, and report its Talon numeric id.
 */
export async function sendContent(
  ctx: { sock: WASocket; gateway: { incrementMessages: (id: number) => void } },
  chat: WhatsAppChatInfo,
  content: AnyMessageContent,
  options: { quoted?: WAMessage } = {},
): Promise<ActionResult> {
  const sent = await ctx.sock.sendMessage(chat.jid, content, options);
  ctx.gateway.incrementMessages(chat.numericChatId);
  if (!sent?.key) return { ok: true };
  const msgId = rememberMessage({
    key: sent.key,
    chatId: chat.chatId,
    message: sent,
    text: "text" in content ? String(content.text ?? "") : "",
    senderName: "bot",
  });
  return { ok: true, message_id: msgId };
}

/**
 * Send text, split across bubbles when it exceeds WhatsApp's limit. The
 * reported message id is the FIRST chunk's: it is the one a reply or
 * reaction should attach to, and the one Talon's callers treat as "the"
 * message.
 */
export async function sendText(
  ctx: { sock: WASocket; gateway: { incrementMessages: (id: number) => void } },
  chat: WhatsAppChatInfo,
  text: string,
  quoted?: WAMessage,
): Promise<ActionResult> {
  const chunks = toWhatsAppChunks(text);
  let first: ActionResult | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const result = await sendContent(
      ctx,
      chat,
      { text: chunk },
      // Only the first chunk quotes — a quoted block on every bubble of a
      // long answer is noise.
      index === 0 && quoted ? { quoted } : {},
    );
    first ??= result;
  }
  log(
    "whatsapp",
    `Sent ${chunks.length} chunk(s) to ${chat.chatId} (${text.length} chars)`,
  );
  return first ?? { ok: true };
}

/**
 * Coerce a user reference the model supplied — bare number, JID, or the
 * numeric id from a member listing — into a WhatsApp user JID.
 */
export function toUserJid(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/[^0-9]/g, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
}
