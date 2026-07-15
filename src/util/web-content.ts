/**
 * Interpretation of fetched web content: charset decoding, text/binary
 * classification, HTML text extraction, and magic-byte validation of binary
 * payloads (via file-type) so server-declared Content-Type headers are never
 * trusted on their own.
 */

import * as cheerio from "cheerio";
import { fileTypeFromBuffer } from "file-type";

/** Binary categories whose content Talon validates against magic bytes. */
export type BinaryKind = "image" | "pdf" | "zip";

export interface DetectedBinary {
  ext: string;
  mime: string;
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

/**
 * Whether a response should be treated as readable text. Servers frequently
 * omit Content-Type or fall back to application/octet-stream, so structured
 * text is also sniffed from the body when the header says nothing useful.
 */
export function isTextContent(mimeType: string, buffer: Buffer): boolean {
  if (isTextMimeType(mimeType)) return true;
  const isGenericMime = !mimeType || mimeType === "application/octet-stream";
  return isGenericMime && looksLikeStructuredText(buffer);
}

/**
 * Whether textual content is an HTML document (declared or sniffed) and thus
 * benefits from DOM text extraction rather than being returned verbatim.
 */
export function isHtmlContent(mimeType: string, text: string): boolean {
  return (
    mimeType.includes("html") || /^<!doctype\s+html|^<html[\s>]/i.test(text)
  );
}

/** Decode a body honoring the declared response charset, defaulting to UTF-8. */
export function decodeText(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(buffer);
  } catch {
    return buffer.toString("utf-8");
  }
}

/** Extract readable text from HTML using cheerio (proper DOM parser). */
export function extractText(html: string, maxLength = 8000): string {
  const $ = cheerio.load(html);
  // Remove non-content elements
  $("script, style, noscript, iframe, svg, nav, footer, header").remove();
  // Get text content, normalize whitespace
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength);
}

/** Identify a binary payload from its magic bytes. */
export async function detectBinaryType(
  buffer: Buffer,
): Promise<DetectedBinary | null> {
  const detected = await fileTypeFromBuffer(buffer);
  return detected ? { ext: detected.ext, mime: detected.mime } : null;
}

/** The binary kind a Content-Type header promises, if it promises one. */
export function advertisedBinaryKind(mimeType: string): BinaryKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.includes("pdf")) return "pdf";
  if (mimeType.includes("zip")) return "zip";
  return null;
}

/** Whether the actual bytes satisfy what the Content-Type header promised. */
export function matchesBinaryKind(
  kind: BinaryKind,
  detected: DetectedBinary | null,
  buffer: Buffer,
): boolean {
  switch (kind) {
    case "image":
      return detected?.mime.startsWith("image/") ?? false;
    case "pdf":
      return detected?.ext === "pdf";
    case "zip":
      // The whole zip family (docx, jar, epub, …) shares the PK signature.
      return buffer[0] === 0x50 && buffer[1] === 0x4b;
  }
}
