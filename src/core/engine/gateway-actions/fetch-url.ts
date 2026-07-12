/**
 * `fetch_url` — fetch a URL, returning extracted text for HTML/JSON or saving
 * binary content (validated by magic bytes) into the uploads workspace.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { extractText } from "./shared.js";
import type { SharedActionHandlers } from "./types.js";

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

class ResponseTooLargeError extends Error {}

/**
 * Read a response incrementally so a missing or dishonest Content-Length
 * header cannot make Talon buffer an unbounded body in memory.
 */
async function readBodyLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new ResponseTooLargeError();
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel("response exceeds download limit");
        } catch {
          // Cancellation is cleanup only; preserve the useful size error.
        }
        throw new ResponseTooLargeError();
      }
      chunks.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength),
      );
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes);
}

type KnownBinaryExtension = "jpg" | "png" | "gif" | "webp" | "pdf" | "zip";

function detectBinaryExtension(buffer: Buffer): KnownBinaryExtension | null {
  const magic = buffer.subarray(0, 16);
  if (magic[0] === 0xff && magic[1] === 0xd8) return "jpg";
  if (
    magic[0] === 0x89 &&
    magic[1] === 0x50 &&
    magic[2] === 0x4e &&
    magic[3] === 0x47
  )
    return "png";
  if (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) return "gif";
  if (
    magic[0] === 0x52 &&
    magic[1] === 0x49 &&
    magic[2] === 0x46 &&
    magic[3] === 0x46 &&
    magic[8] === 0x57 &&
    magic[9] === 0x45 &&
    magic[10] === 0x42 &&
    magic[11] === 0x50
  )
    return "webp";
  if (magic.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (
    magic[0] === 0x50 &&
    magic[1] === 0x4b &&
    ((magic[2] === 0x03 && magic[3] === 0x04) ||
      (magic[2] === 0x05 && magic[3] === 0x06) ||
      (magic[2] === 0x07 && magic[3] === 0x08))
  )
    return "zip";
  return null;
}

function expectedBinaryKind(mimeType: string): "image" | "pdf" | "zip" | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("zip")) return "zip";
  return null;
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml" ||
    mimeType.endsWith("+xml") ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-javascript"
  );
}

function looksLikeStructuredText(buffer: Buffer): boolean {
  if (buffer.subarray(0, 512).includes(0)) return false;
  const sample = buffer.subarray(0, 512).toString("utf-8").trimStart();
  return (
    sample.startsWith("{") ||
    sample.startsWith("[") ||
    sample.startsWith("<?xml") ||
    /^<!doctype\s+html/i.test(sample) ||
    /^<[a-z][\w:-]*(?:\s|>)/i.test(sample)
  );
}

function decodeText(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return buffer.toString("utf-8");
  }
}

export const fetchUrlHandlers: SharedActionHandlers = {
  fetch_url: async (body) => {
    const url = String(body.url ?? "");
    if (!url) return { ok: false, error: "Missing URL" };
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { ok: false, error: "URL must use http or https protocol" };
      }
    } catch {
      return { ok: false, error: "Invalid URL" };
    }
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "Talon/1.0" },
        redirect: "follow",
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const ct = resp.headers.get("content-type") ?? "";

      // Reject oversized responses before downloading the body.
      // The Content-Length header is advisory but saves bandwidth when present.
      const contentLength = resp.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
        return {
          ok: false,
          error: `File too large (${(Number(contentLength) / 1024 / 1024).toFixed(0)}MB, max 20MB)`,
        };
      }

      // Binary content: download and save to workspace
      const mimeType = ct.split(";")[0].trim().toLowerCase();
      let buffer: Buffer;
      try {
        buffer = await readBodyLimited(resp, MAX_RESPONSE_BYTES);
      } catch (err) {
        if (err instanceof ResponseTooLargeError) {
          return { ok: false, error: "Response too large (max 20MB)" };
        }
        throw err;
      }

      const isGenericMime =
        !mimeType || mimeType === "application/octet-stream";
      const isText =
        isTextMimeType(mimeType) ||
        (isGenericMime && looksLikeStructuredText(buffer));

      if (!isText) {
        if (buffer.length === 0)
          return { ok: false, error: "Empty response (0 bytes)" };

        const detectedExt = detectBinaryExtension(buffer);
        const advertisedKind = expectedBinaryKind(mimeType);
        const isImage = ["jpg", "png", "gif", "webp"].includes(
          detectedExt ?? "",
        );
        const contentMatchesHeader =
          !advertisedKind ||
          (advertisedKind === "image"
            ? isImage
            : detectedExt === advertisedKind);

        // Do not save an error page or arbitrary bytes under a trusted-looking
        // image/PDF/ZIP extension merely because the server advertised one.
        if (!contentMatchesHeader) {
          const text = extractText(decodeText(buffer, ct), 500);
          return {
            ok: false,
            error: `Server returned invalid ${advertisedKind} content.${text ? ` Content: ${text}` : ""}`,
          };
        }

        const ext = detectedExt ?? "bin";
        const uploadsDir = dirs.uploads;
        if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
        const filePath = resolve(
          uploadsDir,
          `${Date.now()}-${randomUUID().slice(0, 8)}-fetched.${ext}`,
        );
        writeFileSync(filePath, buffer);
        const typeLabel = isImage
          ? "image"
          : detectedExt === "pdf" || detectedExt === "zip"
            ? detectedExt
            : (ct.split("/")[1]?.split(";")[0] ?? "file");
        return {
          ok: true,
          text: `Downloaded ${typeLabel} (${(buffer.length / 1024).toFixed(0)}KB) to: ${filePath}\nRead it with the Read tool or send it with send(type="file", file_path="${filePath}").`,
        };
      }
      const raw = decodeText(buffer, ct);
      const text = extractText(raw);
      if (text.length < 20)
        return { ok: true, text: "(Page has no readable content)" };
      return { ok: true, text };
    } catch (err) {
      return {
        ok: false,
        error: `Fetch failed: ${err instanceof Error ? err.message : err}`,
      };
    }
  },
};
