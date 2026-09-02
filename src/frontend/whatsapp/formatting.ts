/**
 * Markdown → WhatsApp text.
 *
 * The model writes standard Markdown; WhatsApp renders its own dialect
 * (*bold*, _italic_, ~strike~, `code`, ```blocks```, "> " quotes, and
 * "- "/"1. " lists). Translating between them by running regexes over the
 * raw string is how you end up bolding the asterisks inside a code block
 * or eating the underscores in a URL, so this walks marked's token tree
 * instead: code spans and fenced blocks are separate token types by the
 * time we see them, and emphasis is structural rather than textual.
 *
 * WhatsApp has no escape syntax, so literal delimiters in the source
 * survive as themselves — there is nothing to escape into.
 */

import { marked, type Token, type Tokens } from "marked";
import { splitMessage } from "../telegram/formatting.js";

/** WhatsApp accepts far more, but long bubbles read badly on a phone. */
const WHATSAPP_MAX_TEXT = 4096;

/** Rendered width of a table cell, for the monospace fallback. */
const MAX_TABLE_CELL = 24;

function renderInline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "strong":
      return `*${renderInline((token as Tokens.Strong).tokens)}*`;
    case "em":
      return `_${renderInline((token as Tokens.Em).tokens)}_`;
    case "del":
      return `~${renderInline((token as Tokens.Del).tokens)}~`;
    case "codespan":
      // WhatsApp renders single-backtick spans as inline monospace.
      return `\`${(token as Tokens.Codespan).text}\``;
    case "link": {
      const link = token as Tokens.Link;
      const label = renderInline(link.tokens);
      // WhatsApp auto-links bare URLs but renders no anchor text, so a
      // labelled link has to show both halves or the destination is lost.
      return !label || label === link.href
        ? link.href
        : `${label} (${link.href})`;
    }
    case "image": {
      const image = token as Tokens.Image;
      return image.text ? `${image.text} (${image.href})` : image.href;
    }
    case "br":
      return "\n";
    case "escape":
      return (token as Tokens.Escape).text;
    case "html":
      // Inline HTML has no WhatsApp equivalent — emit the source text.
      return (token as Tokens.HTML).raw;
    default:
      return (token as { text?: string }).text ?? "";
  }
}

function renderListItems(list: Tokens.List, depth: number): string {
  const indent = "  ".repeat(depth);
  return list.items
    .map((item, index) => {
      const marker = list.ordered ? `${Number(list.start || 1) + index}.` : "-";
      // A task item's checkbox is structural in Markdown and cosmetic in
      // WhatsApp; render it as a box so the state still reads.
      const check = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
      const body = renderBlocks(item.tokens ?? [], depth + 1).trimEnd();
      const [first = "", ...rest] = body.split("\n");
      const head = `${indent}${marker} ${check}${first}`;
      // Continuation lines of a wrapped item line up under its text.
      const tail = rest.map((line) => `${indent}  ${line}`);
      return [head, ...tail].join("\n");
    })
    .join("\n");
}

/**
 * Tables have no WhatsApp equivalent. A monospace block keeps the columns
 * aligned, which is the part that carries the meaning.
 */
function renderTable(table: Tokens.Table): string {
  const clip = (s: string): string =>
    s.length > MAX_TABLE_CELL ? `${s.slice(0, MAX_TABLE_CELL - 1)}…` : s;
  const header = table.header.map((cell) => clip(renderInline(cell.tokens)));
  const rows = table.rows.map((row) =>
    row.map((cell) => clip(renderInline(cell.tokens))),
  );
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const separator = widths.map((width) => "─".repeat(width)).join("  ");
  return ["```", line(header), separator, ...rows.map(line), "```"].join("\n");
}

function renderBlockToken(token: Token, depth: number): string {
  switch (token.type) {
    case "heading":
      // WhatsApp has no headings; bold is the only emphasis that reads
      // as a title in a chat bubble.
      return `*${renderInline((token as Tokens.Heading).tokens)}*`;
    case "paragraph":
      return renderInline((token as Tokens.Paragraph).tokens);
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? renderInline(text.tokens) : text.text;
    }
    case "code": {
      const code = token as Tokens.Code;
      return `\`\`\`\n${code.text}\n\`\`\``;
    }
    case "blockquote": {
      const quote = renderBlocks((token as Tokens.Blockquote).tokens, depth);
      return quote
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
    }
    case "list":
      return renderListItems(token as Tokens.List, depth);
    case "table":
      return renderTable(token as Tokens.Table);
    case "hr":
      return "──────────";
    case "html":
      return (token as Tokens.HTML).raw.trim();
    case "space":
      return "";
    default:
      return (token as { text?: string }).text ?? "";
  }
}

function renderBlocks(tokens: Token[], depth = 0): string {
  const parts: string[] = [];
  for (const token of tokens) {
    const rendered = renderBlockToken(token, depth);
    if (rendered !== "") parts.push(rendered);
  }
  // Inside a list item, blocks stack tightly; at top level they get the
  // blank line that separates paragraphs in a bubble.
  return parts.join(depth > 0 ? "\n" : "\n\n");
}

/**
 * Translate Markdown into WhatsApp's formatting dialect. Falls back to
 * the original text if the Markdown can't be parsed — an unformatted
 * message beats a dropped one.
 */
export function toWhatsAppText(text: string): string {
  try {
    return renderBlocks(marked.lexer(text)).trim();
  } catch {
    return text;
  }
}

/** Translate to the WhatsApp dialect, then split into sendable chunks. */
export function toWhatsAppChunks(text: string): string[] {
  return splitMessage(toWhatsAppText(text), WHATSAPP_MAX_TEXT);
}
