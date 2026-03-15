import { describe, it, expect } from "vitest";
import {
  markdownToTelegramHtml,
  splitMessage,
  friendlyError,
} from "../telegram/formatting.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold markdown to <b> tags", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>");
  });

  it("converts italic *text* to <i> tags", () => {
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("converts italic _text_ to <i> tags", () => {
    expect(markdownToTelegramHtml("_italic_")).toBe("<i>italic</i>");
  });

  it("converts inline code to <code> tags", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>");
  });

  it("converts fenced code blocks with language", () => {
    const input = "```python\nprint('hello')\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain('<code class="language-python">');
    expect(result).toContain("print('hello')");
    expect(result).toContain("<pre>");
    expect(result).toContain("</pre>");
  });

  it("converts fenced code blocks without language", () => {
    const input = "```\nsome code\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("some code");
    expect(result).toContain("</code></pre>");
  });

  it("converts links to <a> tags", () => {
    expect(markdownToTelegramHtml("[text](https://example.com)")).toBe(
      '<a href="https://example.com">text</a>',
    );
  });

  it("escapes HTML special characters in plain text", () => {
    // escapeHtml handles &, <, > — single quotes are passed through
    expect(markdownToTelegramHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;",
    );
  });

  it("escapes ampersands in plain text", () => {
    expect(markdownToTelegramHtml("A & B")).toBe("A &amp; B");
  });

  it("handles mixed formatting", () => {
    const input = "**bold** and *italic* and `code`";
    const result = markdownToTelegramHtml(input);
    expect(result).toContain("<b>bold</b>");
    expect(result).toContain("<i>italic</i>");
    expect(result).toContain("<code>code</code>");
  });

  it("converts strikethrough to <s> tags", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toBe("<s>deleted</s>");
  });

  it("does not process markdown inside code blocks", () => {
    const input = "```\n**not bold** *not italic*\n```";
    const result = markdownToTelegramHtml(input);
    expect(result).not.toContain("<b>");
    expect(result).not.toContain("<i>");
  });

  it("does not process markdown inside inline code", () => {
    const input = "`**not bold**`";
    const result = markdownToTelegramHtml(input);
    expect(result).not.toContain("<b>");
    expect(result).toContain("<code>");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(splitMessage("hello", 4096)).toEqual(["hello"]);
  });

  it("splits at newlines when message exceeds max", () => {
    const line = "a".repeat(50);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessage(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
  });

  it("splits at paragraph breaks preferentially", () => {
    const para1 = "a".repeat(40);
    const para2 = "b".repeat(40);
    const text = `${para1}\n\n${para2}`;
    const chunks = splitMessage(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(para1);
    expect(chunks[1]).toBe(para2);
  });

  it("hard-splits when no good break point exists", () => {
    const text = "a".repeat(200);
    const chunks = splitMessage(text, 80);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(80);
  });

  it("returns original text in array when exactly at max", () => {
    const text = "a".repeat(100);
    expect(splitMessage(text, 100)).toEqual([text]);
  });
});

describe("friendlyError", () => {
  it("maps rate limit errors", () => {
    expect(friendlyError(new Error("429 Too Many Requests"))).toContain(
      "Rate limited",
    );
  });

  it("extracts retry-after from rate limit messages", () => {
    const result = friendlyError(
      new Error("rate limit exceeded, retry after 30 seconds"),
    );
    expect(result).toContain("30 seconds");
  });

  it("maps context length errors", () => {
    const result = friendlyError(new Error("context length exceeded"));
    expect(result).toContain("too long");
    expect(result).toContain("/reset");
  });

  it("maps authentication errors", () => {
    const result = friendlyError(new Error("401 Unauthorized"));
    expect(result).toContain("Authentication error");
  });

  it("maps overloaded errors", () => {
    const result = friendlyError(new Error("503 Service Unavailable"));
    expect(result).toContain("overloaded");
  });

  it("maps network errors", () => {
    expect(friendlyError(new Error("ECONNREFUSED"))).toContain("Network error");
    expect(friendlyError(new Error("fetch failed"))).toContain("Network error");
  });

  it("returns generic message for unknown errors", () => {
    const result = friendlyError(new Error("some random failure"));
    expect(result).toContain("Something went wrong");
  });

  it("accepts string errors", () => {
    const result = friendlyError("rate limit hit");
    expect(result).toContain("Rate limited");
  });

  it("passes through session/expired errors as-is", () => {
    const msg = "session expired, please reconnect";
    expect(friendlyError(new Error(msg))).toBe(msg);
  });
});
