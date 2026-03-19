import { describe, it, expect, vi } from "vitest";

vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

describe("teams frontend — action handler", () => {
  // Inline action handler logic for testing without adapter
  function handleTeamsAction(body: Record<string, unknown>): unknown {
    const action = body.action as string;
    switch (action) {
      case "send_message":
        return { ok: true, message_id: `teams-${Date.now()}` };
      case "react":
        return { ok: true };
      case "send_message_with_buttons":
        return { ok: true, message_id: `teams-${Date.now()}` };
      case "edit_message":
        return { ok: true };
      case "delete_message":
        return { ok: true };
      case "send_chat_action":
        return { ok: true };
      case "get_chat_info":
        return { ok: true, id: "19:abc@thread.tacv2", type: "channel", title: "Teams Chat" };
      case "pin_message":
      case "unpin_message":
      case "forward_message":
      case "copy_message":
      case "send_sticker":
      case "send_poll":
      case "send_dice":
      case "send_location":
      case "send_contact":
        return { ok: false, error: `"${action}" is not supported on Teams` };
      case "get_chat_admins":
      case "get_chat_member":
      case "get_chat_member_count":
      case "set_chat_title":
      case "set_chat_description":
      case "get_member_info":
        return { ok: false, error: `"${action}" requires Microsoft Graph API (not yet implemented)` };
      default:
        return null; // delegate to shared actions
    }
  }

  it("send_message returns ok with string message_id", () => {
    const result = handleTeamsAction({ action: "send_message", text: "hello" }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.message_id).toBeDefined();
    expect(typeof result.message_id).toBe("string");
  });

  it("react returns ok (silently)", () => {
    const result = handleTeamsAction({ action: "react", emoji: "👍" }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("send_message_with_buttons returns ok", () => {
    const result = handleTeamsAction({
      action: "send_message_with_buttons",
      text: "Pick one",
      rows: [[{ text: "A" }, { text: "B" }]],
    }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.message_id).toBeDefined();
  });

  it("edit/delete/send_chat_action return ok", () => {
    for (const action of ["edit_message", "delete_message", "send_chat_action"]) {
      const result = handleTeamsAction({ action }) as Record<string, unknown>;
      expect(result.ok).toBe(true);
    }
  });

  it("get_chat_info returns Teams chat info", () => {
    const result = handleTeamsAction({ action: "get_chat_info" }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.type).toBe("channel");
    expect(result.title).toBe("Teams Chat");
  });

  it("Telegram-specific actions return not supported", () => {
    const unsupported = [
      "pin_message", "unpin_message", "forward_message", "copy_message",
      "send_sticker", "send_poll", "send_dice", "send_location", "send_contact",
    ];
    for (const action of unsupported) {
      const result = handleTeamsAction({ action }) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not supported on Teams");
    }
  });

  it("Graph API actions return not yet implemented", () => {
    const graphActions = [
      "get_chat_admins", "get_chat_member", "get_chat_member_count",
      "set_chat_title", "set_chat_description", "get_member_info",
    ];
    for (const action of graphActions) {
      const result = handleTeamsAction({ action }) as Record<string, unknown>;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Graph API");
    }
  });

  it("unknown action returns null (delegate to shared)", () => {
    const result = handleTeamsAction({ action: "some_unknown_action" });
    expect(result).toBeNull();
  });
});

describe("teams frontend — mention stripping", () => {
  function stripBotMention(text: string, botId: string, entities?: Array<{ type: string; mentioned?: { id: string }; text?: string }>): string {
    if (!entities) return text;
    for (const entity of entities) {
      if (entity.type === "mention" && entity.mentioned?.id === botId) {
        const mentionText = entity.text ?? "";
        text = text.replace(mentionText, "").trim();
      }
    }
    return text;
  }

  it("strips bot @mention from text", () => {
    const result = stripBotMention(
      "<at>Talon</at> hello world",
      "bot-123",
      [{ type: "mention", mentioned: { id: "bot-123" }, text: "<at>Talon</at>" }],
    );
    expect(result).toBe("hello world");
  });

  it("preserves text without bot mention", () => {
    const result = stripBotMention(
      "hello world",
      "bot-123",
      [{ type: "mention", mentioned: { id: "user-456" }, text: "<at>User</at>" }],
    );
    expect(result).toBe("hello world");
  });

  it("handles no entities", () => {
    const result = stripBotMention("hello", "bot-123");
    expect(result).toBe("hello");
  });
});

describe("teams frontend — conversation store", () => {
  it("stores and retrieves conversation references", () => {
    const store = new Map<string, unknown>();

    const ref = {
      conversation: { id: "19:abc@thread.tacv2", conversationType: "channel" },
      bot: { id: "bot-123" },
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    };

    store.set("19:abc@thread.tacv2", ref);
    expect(store.get("19:abc@thread.tacv2")).toBe(ref);
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("handles Teams string conversation IDs", () => {
    const teamsIds = [
      "19:abc123@thread.tacv2",
      "a]1234-5678-abcd",
      "29:personal-chat-id",
    ];

    const store = new Map<string, string>();
    for (const id of teamsIds) {
      store.set(id, `ref-for-${id}`);
    }

    expect(store.size).toBe(3);
    for (const id of teamsIds) {
      expect(store.has(id)).toBe(true);
    }
  });
});

describe("teams frontend — formatting", () => {
  // Import splitMessage logic inline for testing
  function splitMessage(text: string, maxLen = 4000): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
      if (splitIdx < maxLen * 0.3) {
        splitIdx = remaining.lastIndexOf("\n", maxLen);
      }
      if (splitIdx < maxLen * 0.3) {
        splitIdx = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitIdx < maxLen * 0.3) {
        splitIdx = maxLen;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }
    return chunks;
  }

  it("returns single chunk for short text", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("splits long text at paragraph break", () => {
    const text = "a".repeat(3000) + "\n\n" + "b".repeat(2000);
    const chunks = splitMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(3000));
    expect(chunks[1]).toBe("b".repeat(2000));
  });

  it("splits at space when no paragraph break", () => {
    const words = Array(500).fill("word").join(" ");
    const chunks = splitMessage(words, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });
});
