/**
 * Media utilities for downloading and processing Telegram media.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export async function downloadFile(
  botToken: string,
  fileId: string,
  fileName: string,
  workspace: string,
): Promise<string> {
  const { default: fetch } = await import("node:https").catch(() => ({ default: globalThis.fetch }));

  // Get file path from Telegram
  const fileResp = await globalThis.fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  );
  const fileData = (await fileResp.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!fileData.ok || !fileData.result?.file_path) {
    throw new Error("Could not get file path from Telegram");
  }

  // Download file
  const url = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  const resp = await globalThis.fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const uploadsDir = resolve(workspace, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const destPath = resolve(uploadsDir, safeName);
  writeFileSync(destPath, buffer);
  return destPath;
}

/** Get file extension from MIME type. */
export function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "video/mp4": ".mp4",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
  };
  return map[mime] || "";
}
