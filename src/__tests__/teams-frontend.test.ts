import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

// ── Test formatting module ──────────────────────────────────────────────────

const { buildAdaptiveCard, splitTeamsMessage, stripHtml } = await import(
  "../frontend/teams/formatting.js"
);

describe("teams formatting", () => {

  describe("buildAdaptiveCard", () => {
    it("builds a basic card with text", () => {
      const card = buildAdaptiveCard("Hello Teams!");
      expect(card.type).toBe("message");
      expect(card.attachments).toHaveLength(1);
      const attachment = (card.attachments as Array<Record<string, unknown>>)[0];
      expect(attachment.contentType).toBe("application/vnd.microsoft.card.adaptive");
      const content = attachment.content as Record<string, unknown>;
      expect(content.type).toBe("AdaptiveCard");
      expect(content.version).toBe("1.5");
      const body = content.body as Array<Record<string, unknown>>;
      expect(body[0].text).toBe("Hello Teams!");
      expect(body[0].wrap).toBe(true);
    });

    it("includes URL buttons as OpenUrl actions", () => {
      const card = buildAdaptiveCard("Pick one:", [
        { text: "Docs", url: "https://docs.example.com" },
        { text: "Repo", url: "https://github.com/example" },
      ]);
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const actions = content.actions as Array<Record<string, unknown>>;
      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe("Action.OpenUrl");
      expect(actions[0].title).toBe("Docs");
      expect(actions[0].url).toBe("https://docs.example.com");
    });

    it("includes non-URL buttons as Submit actions", () => {
      const card = buildAdaptiveCard("Choose:", [
        { text: "Option A" },
        { text: "Option B" },
      ]);
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const actions = content.actions as Array<Record<string, unknown>>;
      expect(actions[0].type).toBe("Action.Submit");
      expect(actions[0].data).toEqual({ choice: "Option A" });
    });

    it("omits actions when no buttons provided", () => {
      const card = buildAdaptiveCard("No buttons");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      expect(content.actions).toBeUndefined();
    });

    it("omits actions for empty button array", () => {
      const card = buildAdaptiveCard("Empty buttons", []);
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      expect(content.actions).toBeUndefined();
    });

    it("renders fenced code block as monospace Container", () => {
      const card = buildAdaptiveCard("```\nconst x = 1;\nconst y = 2;\n```");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const codeBlock = body.find((b) => b.type === "Container");
      expect(codeBlock).toBeDefined();
      const items = codeBlock!.items as Array<Record<string, unknown>>;
      expect(items.some((i) => i.fontType === "Monospace")).toBe(true);
    });

    it("renders unordered list as TextBlock with dashes", () => {
      const card = buildAdaptiveCard("- item one\n- item two\n- item three");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const listBlock = body.find((b) => typeof b.text === "string" && (b.text as string).includes("- item one"));
      expect(listBlock).toBeDefined();
    });

    it("renders ordered list with numeric prefixes", () => {
      const card = buildAdaptiveCard("1. first\n2. second\n3. third");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const listBlock = body.find((b) => typeof b.text === "string" && (b.text as string).includes("1. first"));
      expect(listBlock).toBeDefined();
    });

    it("renders markdown table as Table element", () => {
      const tableMarkdown = "| Header A | Header B |\n| --- | --- |\n| Row 1A | Row 1B |\n| Row 2A | Row 2B |";
      const card = buildAdaptiveCard(tableMarkdown);
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const tableBlock = body.find((b) => b.type === "Table");
      expect(tableBlock).toBeDefined();
      expect(tableBlock!.firstRowAsHeader).toBe(true);
    });

    it("renders blockquote as emphasis Container", () => {
      const card = buildAdaptiveCard("> This is a quote");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const bqBlock = body.find((b) => b.type === "Container" && b.style === "emphasis");
      expect(bqBlock).toBeDefined();
    });

    it("renders horizontal rule as separator TextBlock", () => {
      const card = buildAdaptiveCard("Above\n\n---\n\nBelow");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const hrBlock = body.find((b) => typeof b.text === "string" && (b.text as string).includes("───"));
      expect(hrBlock).toBeDefined();
    });

    it("falls back to TextBlock when body would be empty", () => {
      // A text with only whitespace results in space tokens → empty body → fallback
      const card = buildAdaptiveCard("   \n\n   ");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body[0]!.type).toBe("TextBlock");
    });

    it("renders heading with bold styling", () => {
      const card = buildAdaptiveCard("## Section Title");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const heading = body.find((b) => b.weight === "Bolder");
      expect(heading).toBeDefined();
      expect(heading!.size).toBe("Medium");
    });

    it("replaces empty code block lines with non-breaking space", () => {
      // Empty line in code block triggers (line || " ") branch
      const card = buildAdaptiveCard("```\nfirst line\n\nthird line\n```");
      const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
      const body = content.body as Array<Record<string, unknown>>;
      const codeBlock = body.find((b) => b.type === "Container") as Record<string, unknown> | undefined;
      expect(codeBlock).toBeDefined();
      const items = codeBlock!.items as Array<Record<string, unknown>>;
      // The empty line should become " " (non-breaking space placeholder)
      const emptyLineBlock = items.find((i) => i.text === "\u00a0");
      expect(emptyLineBlock).toBeDefined();
    });

    it("splitTeamsMessage returns remaining text as final chunk", () => {
      // text that splits evenly won't have leftover, test a case with leftover
      const text = "A".repeat(4000) + "\n\n" + "B".repeat(100);
      const chunks = splitTeamsMessage(text, 4500);
      // Should have 1 chunk since total is < 4500
      expect(chunks.join("")).toContain("BBBB");
    });
  });

  describe("splitTeamsMessage", () => {
    it("returns single chunk for short messages", () => {
      expect(splitTeamsMessage("short")).toEqual(["short"]);
    });

    it("splits on paragraph boundaries", () => {
      const text = "A".repeat(5000) + "\n\n" + "B".repeat(5000) + "\n\n" + "C".repeat(100);
      const chunks = splitTeamsMessage(text, 6000);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks[0]).toContain("A");
    });

    it("falls back to line boundaries when no paragraph break", () => {
      const text = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join("\n");
      const chunks = splitTeamsMessage(text, 500);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(500);
      }
    });

    it("hard splits when no newlines available", () => {
      const text = "X".repeat(25000);
      const chunks = splitTeamsMessage(text, 10000);
      expect(chunks.length).toBe(3);
    });

    it("default max is 10000 characters", () => {
      const text = "Y".repeat(15000);
      const chunks = splitTeamsMessage(text);
      expect(chunks.length).toBe(2);
    });
  });

  describe("stripHtml", () => {
    it("strips HTML tags", () => {
      expect(stripHtml("<p>Hello <b>world</b></p>")).toBe("Hello world");
    });

    it("handles nested tags", () => {
      expect(stripHtml("<div><p>Text <em>here</em></p></div>")).toBe("Text here");
    });

    it("returns plain text unchanged", () => {
      expect(stripHtml("no html here")).toBe("no html here");
    });

    it("handles empty string", () => {
      expect(stripHtml("")).toBe("");
    });

    it("decodes HTML entities", () => {
      expect(stripHtml("<p>&amp; &lt; &gt;</p>")).toBe("& < >");
    });

    it("handles Teams-style HTML with mentions", () => {
      const html = '<p><at id="0">User Name</at> hello there</p>';
      const result = stripHtml(html);
      expect(result).toContain("User Name");
      expect(result).toContain("hello there");
    });
  });
});

// ── Test action handler ─────────────────────────────────────────────────────

describe("teams actions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("send_message posts to webhook and increments messages", async () => {
    vi.doMock("../frontend/teams/proxy-fetch.js", () => ({
      proxyFetch: vi.fn(async () => ({ ok: true, text: async () => "" })),
    }));

    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");

    const gateway = new Gateway();
    gateway.setContext(123);
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({ action: "send_message", text: "Hello Teams!" }, 123);
    expect(result?.ok).toBe(true);
    expect(result?.message_id).toBeDefined();
    expect(gateway.getMessageCount(123)).toBe(1);
    gateway.clearContext(123);
  });

  it("send_message returns ok for empty text (no-op)", async () => {
    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({ action: "send_message", text: "" }, 123);
    expect(result?.ok).toBe(true);
  });

  it("send_message handles webhook failure", async () => {
    vi.doMock("../frontend/teams/proxy-fetch.js", () => ({
      proxyFetch: vi.fn(async () => ({ ok: false, status: 500, text: async () => "Internal Error" })),
    }));

    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({ action: "send_message", text: "fail" }, 123);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("failed");
  });

  it("get_chat_info returns channel info", async () => {
    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({ action: "get_chat_info" }, 456);
    expect(result?.ok).toBe(true);
    expect(result?.type).toBe("channel");
    expect(result?.id).toBe(456);
  });

  it("unsupported actions return ok (graceful no-ops)", async () => {
    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    for (const action of ["react", "edit_message", "delete_message", "pin_message", "unpin_message", "forward_message"]) {
      const result = await handler({ action }, 123);
      expect(result?.ok).toBe(true);
    }
  });

  it("unknown actions return null", async () => {
    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({ action: "totally_unknown" }, 123);
    expect(result).toBeNull();
  });

  it("send_message_with_buttons posts card with buttons to webhook", async () => {
    vi.resetModules();
    vi.doMock("../frontend/teams/proxy-fetch.js", () => ({
      proxyFetch: vi.fn(async () => ({ ok: true, status: 200 })),
    }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
    }));
    vi.doMock("../core/plugin.js", () => ({ handlePluginAction: vi.fn(async () => null) }));

    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({
      action: "send_message_with_buttons",
      text: "Choose an option",
      rows: [[{ text: "Option A", url: "https://example.com" }, { text: "Option B" }]],
    }, 123);
    expect(result?.ok).toBe(true);
  });

  it("send_message_with_buttons handles webhook failure", async () => {
    vi.resetModules();
    vi.doMock("../frontend/teams/proxy-fetch.js", () => ({
      proxyFetch: vi.fn(async () => ({ ok: false, status: 503 })),
    }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
    }));
    vi.doMock("../core/plugin.js", () => ({ handlePluginAction: vi.fn(async () => null) }));

    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    const result = await handler({
      action: "send_message_with_buttons",
      text: "Click one",
      rows: [[{ text: "Fail" }]],
    }, 123);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBeDefined();
  });
});

// ── Formatting default token type (branch coverage) ───────────────────────

describe("teams formatting — default token type", () => {
  it("renders raw HTML block via default case", () => {
    // Raw HTML block generates an 'html' token with a text property,
    // which falls into the default: case of the switch in markdownToCardBody
    const card = buildAdaptiveCard("<div>some raw HTML content</div>");
    const content = ((card.attachments as unknown[])[0] as Record<string, unknown>).content as Record<string, unknown>;
    const body = content.body as Array<Record<string, unknown>>;
    expect(body.length).toBeGreaterThan(0);
  });

  it("stripHtml falls back to regex when cheerio throws", async () => {
    vi.resetModules();
    vi.doMock("cheerio", () => ({
      default: {},
      load: vi.fn(() => { throw new Error("cheerio unavailable"); }),
    }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
    }));

    const { stripHtml: stripHtmlFresh } = await import("../frontend/teams/formatting.js");
    const result = stripHtmlFresh("<p>Hello <b>world</b></p>");
    expect(result).toBe("Hello world");
  });
});

// ── teams actions branch coverage ─────────────────────────────────────────

describe("teams actions — branch coverage", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("send_message with undefined text uses empty string fallback", async () => {
    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    // text is undefined → triggers body.text ?? ""
    const result = await handler({ action: "send_message" }, 123);
    expect(result?.ok).toBe(true); // empty text → no-op
  });

  it("send_message_with_buttons with undefined text uses empty string fallback", async () => {
    vi.doMock("../frontend/teams/proxy-fetch.js", () => ({
      proxyFetch: vi.fn(async () => ({ ok: true, status: 200 })),
    }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
    }));
    vi.doMock("../core/plugin.js", () => ({ handlePluginAction: vi.fn(async () => null) }));

    const { Gateway } = await import("../core/gateway.js");
    const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");
    const gateway = new Gateway();
    gateway.setContext(123);
    const handler = createTeamsActionHandler("https://webhook.example.com", gateway);

    // text is undefined → triggers body.text ?? ""
    const result = await handler({ action: "send_message_with_buttons", rows: [[{ text: "OK" }]] }, 123);
    expect(result?.ok).toBe(true);
    gateway.clearContext(123);
  });
});

// ── Test proxy-fetch ────────────────────────────────────────────────────────

describe("proxy-fetch", () => {
  it("exports proxyFetch function", async () => {
    const { proxyFetch } = await import("../frontend/teams/proxy-fetch.js");
    expect(typeof proxyFetch).toBe("function");
  });
});

// ── Test graph client types ─────────────────────────────────────────────────

describe("graph module exports", () => {
  it("exports initGraphClient and GraphClient", async () => {
    const graph = await import("../frontend/teams/graph.js");
    expect(typeof graph.initGraphClient).toBe("function");
    expect(typeof graph.GraphClient).toBe("function");
    expect(typeof graph.deviceCodeAuth).toBe("function");
  });
});
