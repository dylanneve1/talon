/**
 * Media handling — the id → path registry the `/media` route serves from,
 * and the uploads directory client attachments land in.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { dirs } from "../../util/paths.js";
import type { NativeRuntime } from "./runtime.js";

/** Register a file for serving and return its short media id. */
export function registerMedia(
  runtime: NativeRuntime,
  filePath: string,
): string {
  const id = `m${runtime.nextId().toString(36)}`;
  runtime.media.set(id, filePath);
  return id;
}

/** The relative bridge path a client renders a registered media id from. */
export function mediaUrl(mediaId: string): string {
  return `/media?id=${encodeURIComponent(mediaId)}`;
}

/**
 * Persist an uploaded attachment to the workspace uploads dir under a safe,
 * unique name, and return its absolute path (handed to the model to read).
 */
export async function saveUpload(
  runtime: NativeRuntime,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  await mkdir(dirs.uploads, { recursive: true });
  const safe = basename(filename).replace(/[^\w.-]+/g, "_") || "upload";
  const dest = join(
    dirs.uploads,
    `${Date.now()}-${runtime.nextId().toString(36)}-${safe}`,
  );
  await writeFile(dest, bytes);
  return dest;
}
