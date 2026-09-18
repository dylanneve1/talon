/**
 * `native_read` — read a file from the daemon host or, when teleported, from
 * the device.
 *
 * Two things it refuses rather than fakes: a file too big to slurp into
 * memory (bash can slice it) and binary content decoded as UTF-8. Images are
 * the exception — they come back as a viewable image block instead of bytes.
 */

import { readFile, stat as fsStat } from "node:fs/promises";
import { extname } from "node:path";
import { getMeshService } from "../../../mesh/index.js";
import { getTeleport } from "../../../mesh/teleport.js";
import { num, resolvePathParam, str } from "./params.js";
import type { Result } from "./results.js";
import type { SharedActionHandlers } from "../types.js";

const MAX_READ_LINES = 2_000;
/**
 * Refuse to slurp huge files into memory: `read` loads the whole file to
 * slice lines, so an unbounded readFile of a multi-GB log balloons RSS.
 * Past this, bash is the right tool (`sed -n`, `tail`, `head`).
 */
const MAX_READ_FILE_BYTES = 32 * 1024 * 1024;
/**
 * Image extensions the model can actually view, mapped to their MIME type.
 * Reading one returns an image content block instead of the file's raw bytes
 * decoded as (garbage) UTF-8 — so `read`ing a photo/screenshot/design shows
 * the picture, not mojibake.
 */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
/** Anthropic caps a single image around 5MB; refuse larger with a downscale hint. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const readHandlers: SharedActionHandlers = {
  native_read: (body, chatId) =>
    read(chatId, body.path, body.offset, body.limit),
};

async function read(
  chatId: number,
  path: unknown,
  offset: unknown,
  limit: unknown,
): Promise<Result> {
  const address = str(path);
  if (!address) return { ok: false, text: "A file path is required." };
  const active = await getTeleport(chatId);
  const where = active ? active.deviceName : "local";

  const p = resolvePathParam(address, active?.deviceName);
  const shown = p === address ? p : `${address} → ${p}`;

  // Image files: return a viewable image block, not the raw bytes decoded as
  // UTF-8. Without this, `read`ing a photo/screenshot/design hands the model
  // mojibake and it can't see the picture at all.
  const mime = IMAGE_MIME[extname(p).toLowerCase()];
  if (mime) {
    let bytes: Buffer;
    if (active) {
      const res = await getMeshService().readFileBytes(active.deviceId, p);
      if ("error" in res) return { ok: false, text: res.error };
      bytes = res.data;
    } else {
      try {
        // stat first — no point slurping a 40MB photo just to refuse it.
        const st = await fsStat(p);
        if (st.size > MAX_IMAGE_BYTES)
          return oversizeImageResult(shown, where, st.size, p);
        bytes = await readFile(p);
      } catch (err) {
        return {
          ok: false,
          text: `Cannot read ${shown}: ${(err as Error).message}`,
        };
      }
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return oversizeImageResult(shown, where, bytes.length, p);
    }
    return {
      ok: true,
      text: `${shown} [${where}] — image (${mime}, ${bytes.length} bytes)`,
      image: { data: bytes.toString("base64"), mimeType: mime },
    };
  }

  // Clamp: a negative offset would silently flip slice() into
  // count-from-the-end (with line numbers that lie), and a zero/negative
  // limit would return an empty read that looks like an empty file.
  const start = Math.max(0, Math.trunc(num(offset) ?? 0));
  const max = Math.min(
    Math.max(1, Math.trunc(num(limit) ?? MAX_READ_LINES)),
    MAX_READ_LINES,
  );
  let content: string;
  if (active) {
    const res = await getMeshService().readFileBytes(active.deviceId, p);
    if ("error" in res) return { ok: false, text: res.error };
    if (res.data.length > MAX_READ_FILE_BYTES)
      return oversizeReadResult(shown, where, res.data.length, p);
    content = res.data.toString("utf8");
  } else {
    try {
      const st = await fsStat(p);
      if (st.isFile() && st.size > MAX_READ_FILE_BYTES)
        return oversizeReadResult(shown, where, st.size, p);
      content = await readFile(p, "utf8");
    } catch (err) {
      return {
        ok: false,
        text: `Cannot read ${shown}: ${(err as Error).message}`,
      };
    }
  }
  // Binary files decoded as UTF-8 are mojibake the model can't use — same
  // rationale as the image branch, but with no viewable representation to
  // return. Point at the shell tools that can actually inspect the bytes.
  if (content.includes("\0")) {
    return {
      ok: false,
      text:
        `${shown} [${where}] looks binary — refusing to render it as text. ` +
        `Inspect it with bash instead: \`file '${p}'\`, \`xxd '${p}' | head\`, \`strings '${p}'\`.`,
    };
  }
  const lines = content.split("\n");
  if (start >= lines.length) {
    return {
      ok: false,
      text: `${shown} [${where}] has ${lines.length} lines — offset ${start} is past the end.`,
    };
  }
  const slice = lines.slice(start, start + max);
  const numbered = slice
    .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
    .join("\n");
  const more =
    lines.length > start + max
      ? `\n… (${lines.length - start - max} more lines; raise limit/offset)`
      : "";
  return {
    ok: true,
    text: `${shown} [${where}] — ${lines.length} lines\n${numbered}${more}`,
  };
}

function oversizeReadResult(
  shown: string,
  where: string,
  size: number,
  p: string,
): Result {
  return {
    ok: false,
    text:
      `${shown} [${where}] is ${(size / 1_048_576).toFixed(1)}MB — over the ` +
      `${MAX_READ_FILE_BYTES / 1_048_576}MB read limit. Slice it with bash instead: ` +
      `\`sed -n '1,200p' '${p}'\`, \`tail -n 200 '${p}'\`, or \`grep\` for what you need.`,
  };
}

function oversizeImageResult(
  shown: string,
  where: string,
  size: number,
  p: string,
): Result {
  return {
    ok: false,
    text:
      `${shown} [${where}] is ${(size / 1_048_576).toFixed(1)}MB — over the ` +
      `${MAX_IMAGE_BYTES / 1_048_576}MB image limit. Downscale it first ` +
      `(e.g. \`convert '${p}' -resize 1568x /tmp/small.jpg\`) and read that.`,
  };
}
