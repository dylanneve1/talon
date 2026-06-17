/**
 * `fetch_url` — fetch a URL, returning extracted text for HTML/JSON or saving
 * binary content (validated by magic bytes) into the uploads workspace.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "../../../util/paths.js";
import { extractText } from "./shared.js";
import type { SharedActionHandlers } from "./types.js";

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
      const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
      const contentLength = resp.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_BYTES) {
        return {
          ok: false,
          error: `File too large (${(Number(contentLength) / 1024 / 1024).toFixed(0)}MB, max 20MB)`,
        };
      }

      // Binary content: download and save to workspace
      const mimeType = ct.split(";")[0].trim().toLowerCase();
      const isText =
        mimeType.startsWith("text/") || mimeType === "application/json";
      if (!isText) {
        const buffer = Buffer.from(await resp.arrayBuffer());
        if (buffer.length > MAX_BYTES)
          return { ok: false, error: "File too large (max 20MB)" };
        if (buffer.length === 0)
          return { ok: false, error: "Empty response (0 bytes)" };

        // Validate magic bytes — prevent saving HTML error pages as images
        // (servers can return error pages with image content-type headers)
        const magic = buffer.subarray(0, 16);
        const isRealImage =
          (magic[0] === 0xff && magic[1] === 0xd8) || // JPEG
          (magic[0] === 0x89 &&
            magic[1] === 0x50 &&
            magic[2] === 0x4e &&
            magic[3] === 0x47) || // PNG
          (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) || // GIF
          (magic[0] === 0x52 &&
            magic[1] === 0x49 &&
            magic[2] === 0x46 &&
            magic[3] === 0x46 &&
            magic[8] === 0x57 &&
            magic[9] === 0x45 &&
            magic[10] === 0x42 &&
            magic[11] === 0x50); // WebP

        // If content-type says image but bytes say otherwise, treat as text
        if (ct.startsWith("image/") && !isRealImage) {
          const text = extractText(buffer.toString("utf-8"), 500);
          return {
            ok: false,
            error: `Server returned an error page instead of an image. Content: ${text}`,
          };
        }

        const ext = isRealImage
          ? magic[0] === 0xff
            ? "jpg"
            : magic[0] === 0x89
              ? "png"
              : magic[0] === 0x47
                ? "gif"
                : "webp"
          : ct.includes("pdf")
            ? "pdf"
            : ct.includes("zip")
              ? "zip"
              : "bin";
        const uploadsDir = dirs.uploads;
        if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
        const filePath = resolve(uploadsDir, `${Date.now()}-fetched.${ext}`);
        writeFileSync(filePath, buffer);
        const typeLabel = isRealImage
          ? "image"
          : (ct.split("/")[1]?.split(";")[0] ?? "file");
        return {
          ok: true,
          text: `Downloaded ${typeLabel} (${(buffer.length / 1024).toFixed(0)}KB) to: ${filePath}\nRead it with the Read tool or send it with send(type="file", file_path="${filePath}").`,
        };
      }
      const raw = await resp.text();
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
