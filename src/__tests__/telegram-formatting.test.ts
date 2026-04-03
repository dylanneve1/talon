import { describe, it, expect } from "vitest";
import {
  markdownToTelegramHtml,
  splitMessage,
  escapeHtml,
} from "../frontend/telegram/formatting.js";

describe("markdownToTelegramHtml", () => {
  it("converts bold markdown to HTML", () => {
    expect(markdownToTelegramHtml("**hello**")).toContain("<b>hello</b>");
  });

  it("converts italic markdown to HTML", () => {
    expect(markdownToTelegramHtml("_italic_")).toContain("<i>italic</i>");
  });

  it("converts safe https links to anchor tags", () => {
    const result = markdownToTelegramHtml("[click](https://example.com)");
    expect(result).toContain('<a href="https://example.com">click</a>');
  });

  it("strips unsafe non-https links (covers false branch of line 85)", () => {
    // javascript: URL is not safe — should output just the text, not an anchor tag
    const result = markdownToTelegramHtml("[click](javascript:alert('xss'))");
    expect(result).not.toContain("<a href");
    expect(result).toContain("click");
  });

  it("strips unsafe file:// links", () => {
    const result = markdownToTelegramHtml("[file](file:///etc/passwd)");
    expect(result).not.toContain("<a href");
    expect(result).toContain("file");
  });

  it("converts inline code to <code>", () => {
    expect(markdownToTelegramHtml("`code`")).toContain("<code>code</code>");
  });

  it("converts fenced code blocks to pre/code", () => {
    const result = markdownToTelegramHtml("```\nconsole.log('hi')\n```");
    expect(result).toContain("<pre><code>");
    expect(result).toContain("console.log");
  });

  it("converts strikethrough to <s>", () => {
    expect(markdownToTelegramHtml("~~deleted~~")).toContain("<s>deleted</s>");
  });

  it("escapes HTML special chars in text", () => {
    const result = markdownToTelegramHtml("a & b < c > d");
    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
  });
});

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const chunks = splitMessage("Hello", 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Hello");
  });

  it("splits long messages at word boundaries", () => {
    const long = "word ".repeat(200);
    const chunks = splitMessage(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("escapeHtml", () => {
  it("escapes angle brackets and ampersand", () => {
    expect(escapeHtml("<>&")).toBe("&lt;&gt;&amp;");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
