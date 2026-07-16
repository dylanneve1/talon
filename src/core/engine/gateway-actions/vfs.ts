/**
 * VFS — the `talon://` namespace over the gateway: list / read / write.
 * Formatting only; the namespace itself lives in core/vfs.
 */

import { getVfs, type VfsResult, type VfsStat } from "../../vfs/index.js";
import { log } from "../../../util/log.js";
import type { SharedActionHandlers } from "./types.js";

function describeError(
  path: string,
  result: { error: string; detail?: string },
): string {
  return `talon://${path}: ${result.error}${result.detail ? ` — ${result.detail}` : ""}`;
}

function formatSize(entry: VfsStat): string {
  return entry.kind === "dir" ? "-" : String(entry.size ?? "?");
}

function formatEntry(entry: VfsStat): string {
  const kind = entry.kind === "dir" ? "d" : "-";
  const write = entry.writable ? "w" : "-";
  const suffix = entry.kind === "dir" ? "/" : "";
  // Root entries (single-segment paths) show where the mount lives on
  // disk — the bridge for OS-level tools, which can't read talon://.
  const mapping =
    entry.osPath !== undefined && !entry.path.includes("/")
      ? `  → ${entry.osPath}`
      : "";
  return `${kind}${write} ${formatSize(entry).padStart(9)}  ${entry.name}${suffix}${mapping}`;
}

function normalize(body: Record<string, unknown>): string {
  return String(body.path ?? "").trim();
}

export const vfsHandlers: SharedActionHandlers = {
  vfs_list: (body) => {
    const path = normalize(body);
    const result = getVfs().list(path);
    if (!result.ok) return { ok: false, error: describeError(path, result) };
    const header = `talon://${path.replace(/\/+$/, "")}${path ? "/" : ""} (${result.value.length} entries)`;
    const lines = result.value.map(formatEntry);
    return {
      ok: true,
      text: [header, ...(lines.length > 0 ? lines : ["(empty)"])].join("\n"),
    };
  },

  vfs_read: (body) => {
    const path = normalize(body);
    const result = getVfs().read(path);
    if (!result.ok) return { ok: false, error: describeError(path, result) };
    return { ok: true, text: result.value };
  },

  vfs_write: (body) => {
    const path = normalize(body);
    const content = String(body.content ?? "");
    const result: VfsResult<VfsStat> = getVfs().write(path, content);
    if (!result.ok) return { ok: false, error: describeError(path, result) };
    log("gateway", `vfs_write: talon://${result.value.path}`);
    return {
      ok: true,
      text: `Wrote ${result.value.size ?? content.length} bytes to talon://${result.value.path}`,
    };
  },
};
