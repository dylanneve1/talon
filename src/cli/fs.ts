/**
 * `talon ls` / `talon cat` — the talon:// namespace from the outside.
 *
 * A running daemon answers through the gateway (`GET /vfs/list|read`) so
 * the synthetic mounts (proc, plugins) show live state. With no daemon,
 * the same namespace is served in-process — file mounts work identically,
 * the synthetic mounts are simply empty — so browsing the workspace never
 * requires Talon to be up.
 */

import pc from "picocolors";
import { findRunningInstance } from "../core/daemon/discovery.js";
import type { VfsErrorCode, VfsResult, VfsStat } from "../core/vfs/index.js";
import { fetchGateway } from "./daemon-api.js";

/**
 * Ask the daemon first (live proc/plugins state), fall back to serving the
 * namespace in-process. `live` records which one answered.
 */
async function query(
  op: "list" | "read",
  path: string,
): Promise<{ result: VfsResult<VfsStat[] | string>; live: boolean }> {
  const instance = await findRunningInstance();
  if (instance?.port) {
    const body = (await fetchGateway(
      instance.port,
      `/vfs/${op}?path=${encodeURIComponent(path)}`,
    )) as {
      ok: boolean;
      entries?: VfsStat[];
      content?: string;
      error?: string;
      detail?: string;
    };
    const result: VfsResult<VfsStat[] | string> = body.ok
      ? { ok: true, value: op === "list" ? body.entries! : body.content! }
      : {
          ok: false,
          error: (body.error ?? "io-error") as VfsErrorCode,
          ...(body.detail !== undefined ? { detail: body.detail } : {}),
        };
    return { result, live: true };
  }

  const { getVfs } = await import("../core/vfs/index.js");
  const vfs = getVfs();
  return {
    result: op === "list" ? vfs.list(path) : vfs.read(path),
    live: false,
  };
}

function printError(
  path: string,
  result: { error: string; detail?: string },
): void {
  console.error(
    `  ${pc.red("✖")} talon://${path}: ${result.error}${result.detail ? ` — ${result.detail}` : ""}`,
  );
  process.exitCode = 1;
}

function formatModified(entry: VfsStat): string {
  if (entry.modifiedAt === undefined) return "-";
  return new Date(entry.modifiedAt)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

export async function showLs(rawPath: string | undefined): Promise<void> {
  const path = (rawPath ?? "").trim();
  console.log();
  const { result, live } = await query("list", path);
  if (!result.ok) {
    printError(path, result);
    return;
  }
  const entries = result.value as VfsStat[];

  if (!live) {
    console.log(
      `  ${pc.dim("Talon is not running — file mounts only; proc/ and plugins/ are empty.")}`,
    );
  }
  if (entries.length === 0) {
    console.log(`  ${pc.dim("(empty)")}\n`);
    return;
  }

  const header = ["KIND", "SIZE", "MODIFIED", "NAME"];
  const cells = entries.map((entry) => [
    entry.kind === "dir" ? "dir" : "file",
    entry.kind === "dir" ? "-" : String(entry.size ?? "?"),
    formatModified(entry),
    entry.kind === "dir" ? `${entry.name}/` : entry.name,
  ]);
  const widths = header.map((h, col) =>
    Math.max(h.length, ...cells.map((row) => row[col]!.length)),
  );
  console.log(
    `  ${pc.dim(header.map((h, col) => h.padEnd(widths[col]!)).join("  "))}`,
  );
  cells.forEach((row, i) => {
    const padded = row.map((cell, col) => cell.padEnd(widths[col]!));
    const name = entries[i]!.kind === "dir" ? pc.cyan(padded[3]!) : padded[3]!;
    // Root entries carry the mount's disk location — show the mapping, it's
    // what shell commands (which can't read talon://) need.
    const entry = entries[i]!;
    const mapping =
      entry.osPath !== undefined && !entry.path.includes("/")
        ? pc.dim(`  → ${entry.osPath}`)
        : "";
    console.log(
      `  ${padded[0]}  ${padded[1]}  ${padded[2]}  ${name}${mapping}`,
    );
  });
  console.log();
}

export async function showCat(rawPath: string | undefined): Promise<void> {
  if (!rawPath || !rawPath.trim()) {
    console.error(
      `  ${pc.red("✖")} Usage: ${pc.cyan("talon cat <path>")} — e.g. ${pc.cyan("talon cat proc/events")}`,
    );
    process.exitCode = 1;
    return;
  }
  const path = rawPath.trim();
  const { result } = await query("read", path);
  if (!result.ok) {
    printError(path, result);
    return;
  }
  // Raw content, no decoration — `talon cat x | jq` must work.
  process.stdout.write(result.value as string);
}
