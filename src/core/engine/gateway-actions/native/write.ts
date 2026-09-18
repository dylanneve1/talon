/**
 * `native_write` / `native_edit` — the file-mutating half of the native
 * tools, local or teleported.
 *
 * `edit` splices literally (never String.replace, whose `$` patterns would
 * corrupt shell snippets and regexes), refuses binary files, and points at
 * the closest-looking line when old_string doesn't match byte-for-byte.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getMeshService } from "../../../mesh/index.js";
import { getTeleport } from "../../../mesh/devices/teleport.js";
import { resolvePathParam, str } from "./params.js";
import type { Result } from "./results.js";
import type { SharedActionHandlers } from "../types.js";

export const writeHandlers: SharedActionHandlers = {
  native_write: (body, chatId) => write(chatId, body.path, body.content),
  native_edit: (body, chatId) =>
    edit(chatId, body.path, body.old_string, body.new_string, body.replace_all),
};

async function write(
  chatId: number,
  path: unknown,
  content: unknown,
): Promise<Result> {
  const address = str(path);
  if (!address) return { ok: false, text: "A file path is required." };
  const body = typeof content === "string" ? content : "";
  const active = await getTeleport(chatId);
  const p = resolvePathParam(address, active?.deviceName);
  const shown = p === address ? p : `${address} → ${p}`;
  if (active) {
    return getMeshService().writeFileToDevice(active.deviceId, p, body);
  }
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  } catch (err) {
    return {
      ok: false,
      text: `Cannot write ${shown}: ${(err as Error).message}`,
    };
  }
  return {
    ok: true,
    text: `Wrote ${Buffer.byteLength(body, "utf8")} bytes to ${shown} [local].`,
  };
}

async function edit(
  chatId: number,
  path: unknown,
  oldString: unknown,
  newString: unknown,
  replaceAll: unknown,
): Promise<Result> {
  const address = str(path);
  if (!address) return { ok: false, text: "A file path is required." };
  const from = typeof oldString === "string" ? oldString : "";
  const to = typeof newString === "string" ? newString : "";
  if (from === to)
    return { ok: false, text: "old_string and new_string are identical." };
  const active = await getTeleport(chatId);
  const p = resolvePathParam(address, active?.deviceName);
  const shown = p === address ? p : `${address} → ${p}`;
  const svc = getMeshService();

  let content: string;
  if (active) {
    const res = await svc.readFileBytes(active.deviceId, p);
    if ("error" in res) return { ok: false, text: res.error };
    content = res.data.toString("utf8");
  } else {
    try {
      content = await readFile(p, "utf8");
    } catch (err) {
      return {
        ok: false,
        text: `Cannot read ${shown}: ${(err as Error).message}`,
      };
    }
  }

  // Binary guard: decoding binary as UTF-8 is lossy (invalid sequences
  // become U+FFFD), so a read→replace→write round-trip would corrupt every
  // non-text byte — even when old_string matches a clean region.
  if (content.includes("\0")) {
    return {
      ok: false,
      text: `${shown} looks binary — refusing a text edit that would corrupt it. Use bash for byte-level changes.`,
    };
  }

  const count = from ? content.split(from).length - 1 : 0;
  if (count === 0) {
    return {
      ok: false,
      text: `old_string not found in ${shown}.${nearMissHint(content, from)}`,
    };
  }
  if (count > 1 && replaceAll !== true) {
    return {
      ok: false,
      text: `old_string appears ${count}× in ${shown}; pass replace_all or make it unique.`,
    };
  }
  // Splice, not String.replace: replace() treats dollar-sign substitution
  // patterns ($&, $', $BACKTICK, $$) in the replacement as directives, silently
  // corrupting any new_string that contains them (shell snippets, regexes,
  // Makefiles...). split/join and index-splice are both literal.
  const updated =
    replaceAll === true
      ? content.split(from).join(to)
      : spliceOnce(content, from, to);
  const firstLine = content.slice(0, content.indexOf(from)).split("\n").length;

  if (active) {
    const res = await svc.writeFileToDevice(active.deviceId, p, updated);
    return res.ok
      ? {
          ok: true,
          text: `Edited ${shown} [${active.deviceName}] (${count} replacement${count === 1 ? "" : "s"}, first at line ${firstLine}).`,
        }
      : res;
  }
  try {
    await writeFile(p, updated);
  } catch (err) {
    return {
      ok: false,
      text: `Cannot write ${shown}: ${(err as Error).message}`,
    };
  }
  return {
    ok: true,
    text: `Edited ${shown} [local] (${count} replacement${count === 1 ? "" : "s"}, first at line ${firstLine}).`,
  };
}

/**
 * When an edit's old_string doesn't match verbatim, the cause is almost
 * always invisible: indentation, tabs vs spaces, or a trailing space. Point
 * at the closest-looking line so the model re-reads that region instead of
 * blindly retrying the same string.
 */
function nearMissHint(content: string, from: string): string {
  const probe =
    from
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length >= 8) ?? from.trim();
  if (!probe) return "";
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.trim().includes(probe));
  if (idx === -1) return "";
  return (
    `\nLine ${idx + 1} looks close — whitespace/indentation must match the file byte-for-byte. ` +
    `Re-read that region before retrying:\n${String(idx + 1).padStart(6)}\t${lines[idx]}`
  );
}

/** Replace the first occurrence of `from` with `to`, both taken literally. */
function spliceOnce(content: string, from: string, to: string): string {
  const idx = content.indexOf(from);
  if (idx === -1) return content;
  return content.slice(0, idx) + to + content.slice(idx + from.length);
}
