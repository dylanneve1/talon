/**
 * Teams message formatting — markdown to Adaptive Cards + HTML stripping.
 *
 * Uses `marked` lexer to parse markdown into tokens, then converts each
 * token to the appropriate Adaptive Card element:
 *   - Paragraphs/text → TextBlock (with bold/italic markdown, no backticks)
 *   - Fenced code blocks → monospace TextBlock in emphasis Container
 *   - Tables → native Table element (Adaptive Cards v1.5)
 *   - Lists → TextBlock with bullet/number prefixes
 *   - Headings → bold TextBlock
 */

import * as cheerio from "cheerio";
import { marked } from "marked";

/** Max safe message length for a single Adaptive Card. */
const MAX_CHUNK = 10_000;

// ── Markdown → Adaptive Card ──────────────────────────────────────────────

type CardElement = Record<string, unknown>;

/**
 * Convert markdown text to Adaptive Card body elements.
 */
function markdownToCardBody(text: string): CardElement[] {
  const body: CardElement[] = [];
  const tokens = marked.lexer(text);

  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        body.push({ type: "TextBlock", text: `**${cleanInline(token.text)}**`, wrap: true, size: "Medium", weight: "Bolder" });
        break;

      case "paragraph":
        body.push({ type: "TextBlock", text: cleanInline(token.text), wrap: true });
        break;

      case "code": {
        // Each line as a separate TextBlock to preserve newlines.
        // Replace spaces with non-breaking spaces (\u00a0) to preserve alignment —
        // Teams TextBlock collapses consecutive regular spaces.
        const lines = (token.text as string).split("\n");
        body.push({
          type: "Container",
          style: "emphasis",
          items: lines.map((line) => ({
            type: "TextBlock",
            text: (line || " ").replace(/ /g, "\u00a0"),
            wrap: false,
            fontType: "Monospace",
            size: "Small",
            spacing: "None",
          })),
        });
        break;
      }

      case "list": {
        const listToken = token as Record<string, unknown>;
        const items = listToken.items as Array<{ text: string }>;
        const ordered = listToken.ordered as boolean;
        const lines = items.map((item, i) => {
          const prefix = ordered ? `${i + 1}. ` : "- ";
          return prefix + cleanInline(item.text);
        });
        body.push({ type: "TextBlock", text: lines.join("\n"), wrap: true });
        break;
      }

      case "table": {
        const tableToken = token as Record<string, unknown>;
        const header = tableToken.header as Array<{ text: string }>;
        const rows = tableToken.rows as Array<Array<{ text: string }>>;

        const headerRow = {
          type: "TableRow",
          style: "accent",
          cells: header.map((cell) => ({
            type: "TableCell",
            items: [{ type: "TextBlock", text: cleanInline(cell.text), weight: "Bolder", wrap: true }],
          })),
        };

        const dataRows = rows.map((row) => ({
          type: "TableRow",
          cells: row.map((cell) => ({
            type: "TableCell",
            items: [{ type: "TextBlock", text: cleanInline(cell.text), wrap: true }],
          })),
        }));

        body.push({
          type: "Table",
          gridStyle: "accent",
          firstRowAsHeader: true,
          columns: header.map(() => ({ width: 1 })),
          rows: [headerRow, ...dataRows],
        });
        break;
      }

      case "blockquote": {
        const bqToken = token as Record<string, unknown>;
        body.push({
          type: "Container",
          style: "emphasis",
          items: [{ type: "TextBlock", text: cleanInline(String(bqToken.text ?? "")), wrap: true, isSubtle: true }],
        });
        break;
      }

      case "hr":
        body.push({ type: "TextBlock", text: "───────────────────────────────", wrap: false, isSubtle: true });
        break;

      case "space":
        break; // skip whitespace tokens

      default:
        // Fallback: render as plain text
        if ("text" in token && typeof token.text === "string" && token.text.trim()) {
          body.push({ type: "TextBlock", text: cleanInline(token.text), wrap: true });
        }
        break;
    }
  }

  if (body.length === 0) {
    body.push({ type: "TextBlock", text: text || " ", wrap: true });
  }

  return body;
}

/**
 * Clean inline markdown for Teams TextBlock compatibility.
 * Teams supports **bold** and _italic_ but NOT `inline code`.
 */
function cleanInline(text: string): string {
  // Remove inline backticks — Teams doesn't render them
  return text.replace(/`([^`]+)`/g, "$1");
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build an Adaptive Card payload for the Power Automate webhook.
 */
export function buildAdaptiveCard(
  text: string,
  buttons?: Array<{ text: string; url?: string }>,
): Record<string, unknown> {
  const body = markdownToCardBody(text);

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
  };

  if (buttons && buttons.length > 0) {
    card.actions = buttons.map((b) =>
      b.url
        ? { type: "Action.OpenUrl", title: b.text, url: b.url }
        : { type: "Action.Submit", title: b.text, data: { choice: b.text } },
    );
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: card,
      },
    ],
  };
}

/**
 * Split a long message into chunks that each fit within an Adaptive Card.
 * Splits on paragraph boundaries when possible.
 */
export function splitTeamsMessage(text: string, maxLen = MAX_CHUNK): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Strip HTML tags and decode entities from inbound Teams message HTML.
 */
export function stripHtml(html: string): string {
  if (!html || !html.includes("<")) return html;
  try {
    const $ = cheerio.load(html, { xml: false });
    return $.text().trim();
  } catch {
    return html.replace(/<[^>]*>/g, "").trim();
  }
}
