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

  // `***text***` is everyday LLM output. The ** and * passes used to split
  // it into the crossed pair `<b><i>x</b></i>`; Telegram 400s on that, so
  // sendText fell back to a second round-trip with NO formatting and the
  // user saw literal asterisks.
  it("converts ***text*** to properly nested bold+italic", () => {
    expect(markdownToTelegramHtml("***very bold***")).toBe(
      "<b><i>very bold</i></b>",
    );
  });

  it("handles ***text*** alongside plain bold and italic", () => {
    expect(markdownToTelegramHtml("**b** and *i* and ***both***")).toBe(
      "<b>b</b> and <i>i</i> and <b><i>both</i></b>",
    );
  });

  it("handles repeated ***text*** spans", () => {
    expect(markdownToTelegramHtml("***a*** then ***b***")).toBe(
      "<b><i>a</i></b> then <b><i>b</i></b>",
    );
  });

  // Genuinely interleaved delimiters have no valid HTML rendering. Dropping
  // the inline formatting is the correct outcome: Telegram rejects the whole
  // message on a parse error, so emitting crossed tags costs a failed API
  // call and loses the formatting anyway.
  it("drops inline formatting rather than emit crossed tags", () => {
    expect(markdownToTelegramHtml("**a _b** c_")).toBe("**a _b** c_");
  });

  it("still restores code spans when inline formatting is dropped", () => {
    const out = markdownToTelegramHtml("**a _b** c_ and `kept`");
    expect(out).toContain("<code>kept</code>");
    expect(out).not.toContain("<b>");
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

describe("markdownToTelegramHtml — $-substitution and escaping regressions", () => {
  it("keeps $-substitution patterns in inline code literal", () => {
    // String.replace treats $&, $', $`, $$ in a string replacement as
    // substitution directives — code spans containing them used to leak
    // stranded INLINECODEn placeholders into the rendered message.
    const out = markdownToTelegramHtml("use `$&` and `$'` and `$$PID`");
    expect(out).toBe(
      "use <code>$&amp;</code> and <code>$&#39;</code> and <code>$$PID</code>",
    );
    expect(out).not.toContain("INLINECODE");
  });

  it("keeps $-substitution patterns in fenced blocks literal", () => {
    const out = markdownToTelegramHtml('```\necho "$\' $&"\n```');
    expect(out).toBe("<pre><code>echo &quot;$&#39; $&amp;&quot;</code></pre>");
    expect(out).not.toContain("CODEBLOCK");
  });

  it("escapes link href ampersands exactly once", () => {
    const out = markdownToTelegramHtml("[q](https://e.com/?a=1&b=2)");
    expect(out).toBe('<a href="https://e.com/?a=1&amp;b=2">q</a>');
  });

  it("escapes link text exactly once", () => {
    const out = markdownToTelegramHtml("[a & b](https://e.com/)");
    expect(out).toBe('<a href="https://e.com/">a &amp; b</a>');
  });
});

describe("markdownToTelegramHtml — delimiters inside link targets", () => {
  it("does not read asterisks in a URL as emphasis", () => {
    // The Chomikuj percent-encoding pattern that started this: two `*`
    // runs inside the path used to be parsed as italics, crossing the
    // anchor's tags so the guard dropped formatting for the whole message.
    const url = "https://chomikuj.pl/Jak+Si*c4*99+Bawi*c4*85+Ludzie.mp3";
    const out = markdownToTelegramHtml(`[song](${url})`);
    expect(out).toBe(`<a href="${url}">song</a>`);
    expect(out).not.toContain("<i>");
  });

  it("keeps surrounding formatting when a URL contains asterisks", () => {
    const out = markdownToTelegramHtml(
      "**grab** [it](https://e.com/a*b*c.mp3) now",
    );
    expect(out).toBe(
      '<b>grab</b> <a href="https://e.com/a*b*c.mp3">it</a> now',
    );
  });

  it("does not read underscores in a URL as emphasis", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_bar_baz";
    const out = markdownToTelegramHtml(`[wiki](${url})`);
    expect(out).toBe(`<a href="${url}">wiki</a>`);
  });

  it("still formats markup inside the link label", () => {
    const out = markdownToTelegramHtml("[**bold** label](https://e.com/x*y)");
    expect(out).toBe('<a href="https://e.com/x*y"><b>bold</b> label</a>');
  });

  it("restores the target of a rejected scheme instead of stranding a placeholder", () => {
    const out = markdownToTelegramHtml("[x](javascript:alert*1*)");
    expect(out).not.toContain("URL0");
    expect(out).toBe("x");
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

  it("escapes quotes so output is safe in attribute contexts", () => {
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
