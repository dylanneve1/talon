/**
 * Teams message formatting — Adaptive Cards + HTML stripping.
 */

import * as cheerio from "cheerio";

/** Max safe message length for a single Adaptive Card. */
const MAX_CHUNK = 10_000;

/**
 * Build an Adaptive Card payload for the Power Automate webhook.
 *
 * Fenced code blocks (```) are converted to monospace TextBlocks with
 * a grey background, since Adaptive Card TextBlocks don't support
 * markdown code fences and CodeBlock requires schema v1.6+ which
 * Power Automate webhooks don't support.
 */
export function buildAdaptiveCard(
  text: string,
  buttons?: Array<{ text: string; url?: string }>,
): Record<string, unknown> {
  const body = buildCardBody(text);

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.4",
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
 * Build card body — splits code blocks into monospace-styled containers.
 */
function buildCardBody(text: string): Array<Record<string, unknown>> {
  const body: Array<Record<string, unknown>> = [];

  // Split on fenced code blocks: ```lang\ncode\n```
  const codeBlockRegex = /```\w*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index).trim();
    if (before) {
      body.push({ type: "TextBlock", text: before, wrap: true });
    }

    // Render code as a monospace TextBlock inside a grey Container
    const code = match[1].trimEnd();
    body.push({
      type: "Container",
      style: "emphasis",
      bleed: false,
      items: [{
        type: "TextBlock",
        text: code,
        wrap: true,
        fontType: "Monospace",
        size: "Small",
      }],
    });

    lastIndex = match.index + match[0].length;
  }

  const remaining = text.slice(lastIndex).trim();
  if (remaining) {
    body.push({ type: "TextBlock", text: remaining, wrap: true });
  }

  if (body.length === 0) {
    body.push({ type: "TextBlock", text: text || " ", wrap: true });
  }

  // Strip inline backticks from TextBlocks — Teams doesn't render them
  for (const el of body) {
    if (el.type === "TextBlock" && typeof el.text === "string") {
      el.text = (el.text as string).replace(/`([^`]+)`/g, "$1");
    }
  }

  return body;
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
    // Try to split on a double newline (paragraph boundary)
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      // If no good paragraph break, try single newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // Hard split at maxLen
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
 * Falls back to plain regex if cheerio fails.
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
