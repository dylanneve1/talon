/**
 * Media-source resolution for the WhatsApp send actions: workspace path or
 * public URL → something Baileys can upload, plus the mimetype guess the
 * document/audio paths need.
 */

import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { expandFsPath } from "../../../util/fs-path.js";

/** WhatsApp's own ceiling for a media upload. */
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

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
