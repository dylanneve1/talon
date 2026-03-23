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
