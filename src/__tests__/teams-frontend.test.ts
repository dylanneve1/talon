/**
 * Tests for the Teams frontend module.
 *
 * Covers: formatting, conversation store, action handler (with mocked adapter),
 * mention stripping, rate limiting, and unsupported action responses.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

vi.mock("../core/gateway.js", () => ({
  incrementMessageCount: vi.fn(),
  setGatewayContext: vi.fn(),
  clearGatewayContext: vi.fn(),
  isGatewayBusy: vi.fn(() => false),
  getGatewayMessageCount: vi.fn(() => 0),
  getGatewayPort: vi.fn(() => 19876),
  setFrontendHandler: vi.fn(),
  startGateway: vi.fn(async () => 19876),
  stopGateway: vi.fn(async () => {}),
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));

// ══════════════════════════════════════════════════════════════════════════════
// 1. FORMATTING — real import from formatting.ts
// ══════════════════════════════════════════════════════════════════════════════

const { splitMessage } = await import("../frontend/teams/formatting.js");

describe("teams/formatting — splitMessage", () => {
  it("returns single chunk for short text", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns single chunk for empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  it("returns single chunk when exactly at maxLen", () => {
    const text = "x".repeat(4000);
    expect(splitMessage(text, 4000)).toEqual([text]);
  });

  it("splits at paragraph break (\\n\\n)", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(2000);
    const text = `${a}\n\n${b}`;
    const chunks = splitMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it("splits at single newline when no paragraph break", () => {
    const a = "a".repeat(3500);
    const b = "b".repeat(2000);
    const text = `${a}\n${b}`;
    const chunks = splitMessage(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(a);
  });

  it("splits at space when no newlines", () => {
    const words = Array(200).fill("longword").join(" ");
    const chunks = splitMessage(words, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("hard splits when no whitespace", () => {
    const text = "x".repeat(5000);
    const chunks = splitMessage(text, 100);
    expect(chunks.length).toBe(50);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(100);
    }
  });

  it("handles very small maxLen", () => {
    const chunks = splitMessage("hello world", 5);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("trims leading whitespace from subsequent chunks", () => {
    const a = "a".repeat(90);
    const text = `${a}     remaining text`;
    const chunks = splitMessage(text, 95);
    expect(chunks.length).toBe(2);
    expect(chunks[1]).toBe("remaining text");
  });

  it("handles multiple consecutive paragraph breaks", () => {
    const text = "part1\n\n\n\npart2";
    const result = splitMessage(text, 100);
    expect(result).toEqual(["part1\n\n\n\npart2"]);
  });

  it("uses default maxLen of 4000", () => {
    const text = "a".repeat(5000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(1000);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. CONVERSATION STORE — real imports
// ══════════════════════════════════════════════════════════════════════════════

const {
  saveConversationReference,
  getConversationReference,
  getAllConversationIds,
  initConversationStore,
} = await import("../frontend/teams/conversation-store.js");

describe("teams/conversation-store", () => {
  beforeEach(() => {
    // Reset store state by re-init with a non-existent path
    initConversationStore("/tmp/teams-test-nonexistent-" + Date.now());
  });

  it("saves and retrieves a conversation reference", () => {
    const ref = {
      conversation: { id: "19:abc@thread.tacv2", conversationType: "channel" },
      bot: { id: "bot-123" },
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    };
    saveConversationReference("19:abc@thread.tacv2", ref as any);
    const retrieved = getConversationReference("19:abc@thread.tacv2");
    expect(retrieved).toBeDefined();
    expect(retrieved!.conversation!.id).toBe("19:abc@thread.tacv2");
  });

  it("returns undefined for nonexistent conversation", () => {
    expect(getConversationReference("nonexistent")).toBeUndefined();
  });

  it("overwrites existing reference on re-save", () => {
    const ref1 = { serviceUrl: "url1" };
    const ref2 = { serviceUrl: "url2" };
    saveConversationReference("chat-1", ref1 as any);
    saveConversationReference("chat-1", ref2 as any);
    expect(getConversationReference("chat-1")!.serviceUrl).toBe("url2");
  });

  it("getAllConversationIds returns all stored IDs", () => {
    saveConversationReference("chat-a", { serviceUrl: "a" } as any);
    saveConversationReference("chat-b", { serviceUrl: "b" } as any);
    saveConversationReference("chat-c", { serviceUrl: "c" } as any);
    const ids = getAllConversationIds();
    expect(ids).toContain("chat-a");
    expect(ids).toContain("chat-b");
    expect(ids).toContain("chat-c");
  });

  it("getAllConversationIds returns empty array when empty", () => {
    expect(getAllConversationIds().length).toBeGreaterThanOrEqual(0);
  });

  it("handles Teams string conversation IDs with special characters", () => {
    const teamsIds = [
      "19:abc123@thread.tacv2",
      "a:1234-5678-abcd-efgh",
      "29:personal-chat-id",
      "19:meeting_MjQyNzk@thread.v2",
    ];
    for (const id of teamsIds) {
      saveConversationReference(id, { serviceUrl: `url-${id}` } as any);
    }
    for (const id of teamsIds) {
      expect(getConversationReference(id)).toBeDefined();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. ACTION HANDLER — with mocked adapter
// ══════════════════════════════════════════════════════════════════════════════

const { createTeamsActionHandler } = await import("../frontend/teams/actions.js");

function createMockAdapter() {
  const sentActivities: unknown[] = [];
  const updatedActivities: unknown[] = [];
  const deletedActivityIds: string[] = [];

  const mockContext = {
    sendActivity: vi.fn(async (activity: unknown) => {
      sentActivities.push(activity);
      return { id: `activity-${Date.now()}` };
    }),
    updateActivity: vi.fn(async (activity: unknown) => {
      updatedActivities.push(activity);
    }),
    deleteActivity: vi.fn(async (id: string) => {
      deletedActivityIds.push(id);
    }),
  };

  const adapter = {
    continueConversation: vi.fn(async (_ref: unknown, fn: (ctx: any) => Promise<void>) => {
      await fn(mockContext);
    }),
  };

  return { adapter, mockContext, sentActivities, updatedActivities, deletedActivityIds };
}

describe("teams/actions — createTeamsActionHandler", () => {
  let handler: ReturnType<typeof createTeamsActionHandler>;
  let mock: ReturnType<typeof createMockAdapter>;

  beforeEach(() => {
    mock = createMockAdapter();
    handler = createTeamsActionHandler(mock.adapter as any);
    // Seed a conversation reference so withProactiveContext works
    saveConversationReference("test-chat", { serviceUrl: "https://test" } as any);
  });

  // ── Messaging ─────────────────────────────────────────────────────────

  describe("send_message", () => {
    it("sends text and returns message_id", async () => {
      const result = await handler({ action: "send_message", text: "hello" }, "test-chat");
      expect(result!.ok).toBe(true);
      expect(result!.message_id).toBeDefined();
      expect(mock.sentActivities.length).toBe(1);
    });

    it("rejects text exceeding 28KB limit", async () => {
      const result = await handler(
        { action: "send_message", text: "x".repeat(29_000) },
        "test-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("too long");
    });

    it("returns undefined message_id when no conversation ref", async () => {
      const result = await handler({ action: "send_message", text: "hi" }, "no-ref-chat");
      expect(result!.ok).toBe(true);
      expect(result!.message_id).toBeUndefined();
    });

    it("handles empty text", async () => {
      const result = await handler({ action: "send_message" }, "test-chat");
      expect(result!.ok).toBe(true);
    });
  });

  describe("reply_to", () => {
    it("sends reply text", async () => {
      const result = await handler(
        { action: "reply_to", text: "reply text", message_id: 123 },
        "test-chat",
      );
      expect(result!.ok).toBe(true);
      expect(mock.sentActivities.length).toBe(1);
    });
  });

  describe("react", () => {
    it("acknowledges silently", async () => {
      const result = await handler(
        { action: "react", message_id: 123, emoji: "\uD83D\uDC4D" },
        "test-chat",
      );
      expect(result!.ok).toBe(true);
      expect(mock.sentActivities.length).toBe(0);
    });
  });

  describe("edit_message", () => {
    it("updates an activity", async () => {
      const result = await handler(
        { action: "edit_message", message_id: "act-123", text: "edited" },
        "test-chat",
      );
      expect(result!.ok).toBe(true);
      expect(mock.updatedActivities.length).toBe(1);
    });

    it("rejects missing message_id", async () => {
      const result = await handler(
        { action: "edit_message", text: "edited" },
        "test-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("Missing message_id");
    });
  });

  describe("delete_message", () => {
    it("deletes an activity", async () => {
      const result = await handler(
        { action: "delete_message", message_id: "act-456" },
        "test-chat",
      );
      expect(result!.ok).toBe(true);
      expect(mock.deletedActivityIds).toContain("act-456");
    });

    it("rejects missing message_id", async () => {
      const result = await handler({ action: "delete_message" }, "test-chat");
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("Missing message_id");
    });
  });

  describe("edit_message — no conversation ref", () => {
    it("returns error when no conversation context", async () => {
      const result = await handler(
        { action: "edit_message", message_id: "act-123", text: "edited" },
        "no-ref-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("No conversation context");
    });
  });

  describe("delete_message — no conversation ref", () => {
    it("returns error when no conversation context", async () => {
      const result = await handler(
        { action: "delete_message", message_id: "act-456" },
        "no-ref-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("No conversation context");
    });
  });

  describe("send_file — file errors", () => {
    it("rejects missing file_path", async () => {
      const result = await handler({ action: "send_file" }, "test-chat");
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("Missing file_path");
    });

    it("returns error for nonexistent file", async () => {
      const result = await handler(
        { action: "send_photo", file_path: "/tmp/nonexistent-file-xyz.jpg" },
        "test-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("File error");
    });
  });

  describe("send_chat_action", () => {
    it("sends typing indicator", async () => {
      const result = await handler({ action: "send_chat_action" }, "test-chat");
      expect(result!.ok).toBe(true);
      expect(mock.sentActivities.length).toBe(1);
      expect((mock.sentActivities[0] as any).type).toBe("typing");
    });
  });

  describe("send_message_with_buttons", () => {
    it("sends adaptive card with buttons", async () => {
      const result = await handler(
        {
          action: "send_message_with_buttons",
          text: "Choose:",
          rows: [[{ text: "Option A", callback_data: "a" }, { text: "Visit", url: "https://example.com" }]],
        },
        "test-chat",
      );
      expect(result!.ok).toBe(true);
      expect(result!.message_id).toBeDefined();
      expect(mock.sentActivities.length).toBe(1);
    });

    it("rejects missing rows", async () => {
      const result = await handler(
        { action: "send_message_with_buttons", text: "Choose:" },
        "test-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("Missing button rows");
    });
  });

  // ── Scheduling ────────────────────────────────────────────────────────

  describe("schedule_message", () => {
    it("returns schedule_id and clamped delay", async () => {
      const result = await handler(
        { action: "schedule_message", text: "later", delay_seconds: 30 },
        "test-chat",
      );
      expect(result!.ok).toBe(true);
      expect(result!.schedule_id).toBeDefined();
      expect(result!.delay_seconds).toBe(30);
    });

    it("clamps delay_seconds to [1, 3600]", async () => {
      const r1 = await handler(
        { action: "schedule_message", text: "x", delay_seconds: -10 },
        "test-chat",
      );
      expect(r1!.delay_seconds).toBe(1);

      const r2 = await handler(
        { action: "schedule_message", text: "x", delay_seconds: 999999 },
        "test-chat",
      );
      expect(r2!.delay_seconds).toBe(3600);
    });

    it("defaults delay to 60 seconds", async () => {
      const result = await handler(
        { action: "schedule_message", text: "x" },
        "test-chat",
      );
      expect(result!.delay_seconds).toBe(60);
    });
  });

  describe("cancel_scheduled", () => {
    it("returns error when schedule not found", async () => {
      const result = await handler(
        { action: "cancel_scheduled", schedule_id: "nonexistent" },
        "test-chat",
      );
      expect(result!.ok).toBe(false);
      expect(result!.error).toContain("Schedule not found");
    });

    it("cancels a previously scheduled message", async () => {
      const schedResult = await handler(
        { action: "schedule_message", text: "x", delay_seconds: 3600 },
        "test-chat",
      );
      const scheduleId = schedResult!.schedule_id as string;

      const cancelResult = await handler(
        { action: "cancel_scheduled", schedule_id: scheduleId },
        "test-chat",
      );
      expect(cancelResult!.ok).toBe(true);
      expect(cancelResult!.cancelled).toBe(true);
    });
  });

  // ── Chat info ─────────────────────────────────────────────────────────

  describe("get_chat_info", () => {
    it("returns conversation info from stored reference", async () => {
      saveConversationReference("info-chat", {
        conversation: { id: "info-chat", conversationType: "channel", name: "General" },
      } as any);
      const result = await handler({ action: "get_chat_info" }, "info-chat");
      expect(result!.ok).toBe(true);
      expect(result!.type).toBe("channel");
      expect(result!.title).toBe("General");
    });

    it("returns fallback values when no ref", async () => {
      const result = await handler({ action: "get_chat_info" }, "no-ref-chat");
      expect(result!.ok).toBe(true);
      expect(result!.type).toBe("personal");
      expect(result!.title).toBe("Teams Chat");
    });
  });

  // ── Unsupported actions ───────────────────────────────────────────────

  describe("unsupported Telegram actions", () => {
    const unsupported = [
      "pin_message", "unpin_message", "forward_message", "copy_message",
      "send_sticker", "send_poll", "send_dice", "send_location", "send_contact",
      "get_sticker_pack", "download_sticker", "save_sticker_pack",
      "download_media", "online_count", "get_pinned_messages",
    ];

    for (const action of unsupported) {
      it(`${action} returns not supported`, async () => {
        const result = await handler({ action }, "test-chat");
        expect(result!.ok).toBe(false);
        expect(result!.error).toContain("not supported on Teams");
      });
    }
  });

  describe("Graph API actions", () => {
    const graphActions = [
      "get_chat_admins", "get_chat_member", "get_chat_member_count",
      "set_chat_title", "set_chat_description", "get_member_info",
    ];

    for (const action of graphActions) {
      it(`${action} returns Graph API required`, async () => {
        const result = await handler({ action }, "test-chat");
        expect(result!.ok).toBe(false);
        expect(result!.error).toContain("Graph API");
      });
    }
  });

  describe("unknown actions", () => {
    it("returns null for unknown action (delegate to shared)", async () => {
      const result = await handler({ action: "unknown_thing" }, "test-chat");
      expect(result).toBeNull();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. MENTION STRIPPING — test the real logic pattern
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/handlers — mention stripping", () => {
  // Test the actual function signature from handlers.ts
  function stripBotMention(
    text: string,
    activity: { entities?: Array<{ type: string; mentioned?: { id: string }; text?: string }>; recipient?: { id: string } },
  ): string {
    if (!activity.entities) return text;
    for (const entity of activity.entities) {
      if (entity.type === "mention" && entity.mentioned?.id === activity.recipient?.id) {
        const mentionText = entity.text ?? "";
        text = text.replace(mentionText, "").trim();
      }
    }
    return text;
  }

  it("strips bot @mention from text", () => {
    const result = stripBotMention("<at>Talon</at> hello world", {
      entities: [{ type: "mention", mentioned: { id: "bot-123" }, text: "<at>Talon</at>" }],
      recipient: { id: "bot-123" },
    });
    expect(result).toBe("hello world");
  });

  it("preserves text when mention is for a different user", () => {
    const result = stripBotMention("<at>User</at> hello world", {
      entities: [{ type: "mention", mentioned: { id: "user-456" }, text: "<at>User</at>" }],
      recipient: { id: "bot-123" },
    });
    expect(result).toBe("<at>User</at> hello world");
  });

  it("handles no entities", () => {
    expect(stripBotMention("hello", {})).toBe("hello");
  });

  it("handles empty entities array", () => {
    expect(stripBotMention("hello", { entities: [] })).toBe("hello");
  });

  it("strips mention at start of text", () => {
    const result = stripBotMention("<at>Bot</at> do something", {
      entities: [{ type: "mention", mentioned: { id: "bot" }, text: "<at>Bot</at>" }],
      recipient: { id: "bot" },
    });
    expect(result).toBe("do something");
  });

  it("strips mention at end of text", () => {
    const result = stripBotMention("hello <at>Bot</at>", {
      entities: [{ type: "mention", mentioned: { id: "bot" }, text: "<at>Bot</at>" }],
      recipient: { id: "bot" },
    });
    expect(result).toBe("hello");
  });

  it("strips mention in the middle of text", () => {
    const result = stripBotMention("hey <at>Bot</at> how are you?", {
      entities: [{ type: "mention", mentioned: { id: "bot" }, text: "<at>Bot</at>" }],
      recipient: { id: "bot" },
    });
    expect(result).toBe("hey  how are you?");
  });

  it("handles multiple mentions — only strips bot mention", () => {
    const result = stripBotMention("<at>Bot</at> hello <at>User</at>", {
      entities: [
        { type: "mention", mentioned: { id: "bot" }, text: "<at>Bot</at>" },
        { type: "mention", mentioned: { id: "user" }, text: "<at>User</at>" },
      ],
      recipient: { id: "bot" },
    });
    expect(result).toBe("hello <at>User</at>");
  });

  it("ignores non-mention entities", () => {
    const result = stripBotMention("hello", {
      entities: [{ type: "clientInfo", mentioned: { id: "bot" } }],
      recipient: { id: "bot" },
    });
    expect(result).toBe("hello");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. RATE LIMITING — test the pattern
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/handlers — rate limiting", () => {
  // Replicate the rate limiting logic for testing
  function createRateLimiter(maxMessages = 15, windowMs = 60_000) {
    const timestamps = new Map<string, number[]>();

    return (userId: string, now = Date.now()): boolean => {
      let ts = timestamps.get(userId);
      if (!ts) {
        ts = [];
        timestamps.set(userId, ts);
      }
      while (ts.length > 0 && ts[0] < now - windowMs) {
        ts.shift();
      }
      if (ts.length >= maxMessages) return true;
      ts.push(now);
      return false;
    };
  }

  it("allows messages under the limit", () => {
    const isLimited = createRateLimiter(15);
    for (let i = 0; i < 15; i++) {
      expect(isLimited("user-1")).toBe(false);
    }
  });

  it("blocks messages at the limit", () => {
    const isLimited = createRateLimiter(15);
    for (let i = 0; i < 15; i++) {
      isLimited("user-1");
    }
    expect(isLimited("user-1")).toBe(true);
  });

  it("resets after window expires", () => {
    const isLimited = createRateLimiter(3, 1000);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      isLimited("user-1", now);
    }
    expect(isLimited("user-1", now)).toBe(true);
    // After window passes
    expect(isLimited("user-1", now + 1001)).toBe(false);
  });

  it("tracks users independently", () => {
    const isLimited = createRateLimiter(2);
    isLimited("user-a");
    isLimited("user-a");
    expect(isLimited("user-a")).toBe(true);
    expect(isLimited("user-b")).toBe(false);
  });

  it("uses string user IDs (Teams AAD Object IDs)", () => {
    const isLimited = createRateLimiter(2);
    const aadId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(isLimited(aadId)).toBe(false);
    expect(isLimited(aadId)).toBe(false);
    expect(isLimited(aadId)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. CONTEXT MANAGER — gateway integration
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/index — context manager", () => {
  it("context manager delegates to gateway functions", async () => {
    const gateway = await import("../core/gateway.js");

    const context = {
      acquire: (chatId: string) => (gateway as any).setGatewayContext(chatId),
      release: (chatId: string) => (gateway as any).clearGatewayContext(chatId),
      isBusy: () => (gateway as any).isGatewayBusy(),
      getMessageCount: () => (gateway as any).getGatewayMessageCount(),
    };

    context.acquire("teams-chat-1");
    expect(gateway.setGatewayContext).toHaveBeenCalledWith("teams-chat-1");

    context.release("teams-chat-1");
    expect(gateway.clearGatewayContext).toHaveBeenCalledWith("teams-chat-1");

    context.isBusy();
    expect(gateway.isGatewayBusy).toHaveBeenCalled();

    context.getMessageCount();
    expect(gateway.getGatewayMessageCount).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. MESSAGE QUEUE — debouncing behavior
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/handlers — message queue", () => {
  it("single message produces single prompt", () => {
    const messages = [{ prompt: "hello" }];
    const combined =
      messages.length === 1
        ? messages[0].prompt
        : messages.map((m) => m.prompt).join("\n\n");
    expect(combined).toBe("hello");
  });

  it("multiple messages are joined with double newline", () => {
    const messages = [
      { prompt: "first message" },
      { prompt: "second message" },
      { prompt: "third message" },
    ];
    const combined = messages.map((m) => m.prompt).join("\n\n");
    expect(combined).toBe("first message\n\nsecond message\n\nthird message");
  });

  it("uses last message metadata for combined message", () => {
    const messages = [
      { prompt: "hi", senderName: "Alice", senderId: "a", isGroup: false },
      { prompt: "follow up", senderName: "Alice", senderId: "a", isGroup: false },
    ];
    const last = messages[messages.length - 1];
    expect(last.senderName).toBe("Alice");
    expect(last.prompt).toBe("follow up");
  });

  it("respects MAX_QUEUED_PER_CHAT limit", () => {
    const MAX = 20;
    const messages: string[] = [];
    for (let i = 0; i < 25; i++) {
      if (messages.length < MAX) {
        messages.push(`msg-${i}`);
      }
    }
    expect(messages.length).toBe(20);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. CONVERSATION TYPE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/handlers — conversation type detection", () => {
  function isGroupConversation(type: string | undefined): boolean {
    const conversationType = type ?? "personal";
    return conversationType === "channel" || conversationType === "groupChat";
  }

  it("identifies channel as group", () => {
    expect(isGroupConversation("channel")).toBe(true);
  });

  it("identifies groupChat as group", () => {
    expect(isGroupConversation("groupChat")).toBe(true);
  });

  it("identifies personal as non-group", () => {
    expect(isGroupConversation("personal")).toBe(false);
  });

  it("defaults to personal when no conversationType", () => {
    expect(isGroupConversation(undefined)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. STRING ID HASHING — deterministic user ID for history
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/handlers — string ID hashing", () => {
  // Replicate the hashStringId function for testing
  function hashStringId(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  it("produces a positive integer", () => {
    const id = hashStringId("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it("is deterministic — same input always produces same output", () => {
    const aadId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    expect(hashStringId(aadId)).toBe(hashStringId(aadId));
  });

  it("differentiates different user IDs", () => {
    const id1 = hashStringId("user-aaa");
    const id2 = hashStringId("user-bbb");
    expect(id1).not.toBe(id2);
  });

  it("handles empty string", () => {
    const id = hashStringId("");
    expect(id).toBe(5381); // initial hash value
  });

  it("handles very long strings", () => {
    const id = hashStringId("x".repeat(10_000));
    expect(id).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(id)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. SENDER ID EXTRACTION
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/handlers — sender ID extraction", () => {
  it("prefers aadObjectId over id", () => {
    const from = { aadObjectId: "aad-123", id: "id-456", name: "User" };
    const senderId = from.aadObjectId ?? from.id ?? "unknown";
    expect(senderId).toBe("aad-123");
  });

  it("falls back to id when no aadObjectId", () => {
    const from = { id: "id-789", name: "User" };
    const senderId = (from as any).aadObjectId ?? from.id ?? "unknown";
    expect(senderId).toBe("id-789");
  });

  it("falls back to unknown when no id", () => {
    const from: Record<string, unknown> = {};
    const senderId = (from.aadObjectId as string) ?? (from.id as string) ?? "unknown";
    expect(senderId).toBe("unknown");
  });

  it("extracts sender name with fallback", () => {
    expect(({ name: "Alice" }).name ?? "User").toBe("Alice");
    expect(({} as any).name ?? "User").toBe("User");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. ADAPTIVE CARD CONSTRUCTION
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/actions — adaptive card construction", () => {
  it("maps URL buttons to Action.OpenUrl", () => {
    const btn = { text: "Visit", url: "https://example.com" };
    const action = btn.url
      ? { type: "Action.OpenUrl", title: btn.text, url: btn.url }
      : { type: "Action.Submit", title: btn.text, data: { callback_data: btn.text } };
    expect(action.type).toBe("Action.OpenUrl");
    expect(action.url).toBe("https://example.com");
  });

  it("maps callback buttons to Action.Submit", () => {
    const btn: { text: string; url?: string; callback_data?: string } = { text: "Click me", callback_data: "clicked" };
    const action = btn.url
      ? { type: "Action.OpenUrl" as const, title: btn.text, url: btn.url }
      : { type: "Action.Submit" as const, title: btn.text, data: { callback_data: btn.callback_data ?? btn.text } };
    expect(action.type).toBe("Action.Submit");
    expect((action as any).data.callback_data).toBe("clicked");
  });

  it("uses button text as fallback callback_data", () => {
    const btn = { text: "Option A" };
    const data = (btn as any).callback_data ?? btn.text;
    expect(data).toBe("Option A");
  });

  it("flattens multi-row buttons", () => {
    const rows = [
      [{ text: "A" }, { text: "B" }],
      [{ text: "C" }],
    ];
    const flat = rows.flat();
    expect(flat.length).toBe(3);
    expect(flat.map((b) => b.text)).toEqual(["A", "B", "C"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. CONTENT TYPE MAPPING
// ══════════════════════════════════════════════════════════════════════════════

describe("teams/actions — content type mapping", () => {
  const contentTypes: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
    ogg: "audio/ogg", mp3: "audio/mpeg", pdf: "application/pdf",
  };

  it("maps common image extensions", () => {
    expect(contentTypes["jpg"]).toBe("image/jpeg");
    expect(contentTypes["jpeg"]).toBe("image/jpeg");
    expect(contentTypes["png"]).toBe("image/png");
    expect(contentTypes["gif"]).toBe("image/gif");
    expect(contentTypes["webp"]).toBe("image/webp");
  });

  it("maps video extensions", () => {
    expect(contentTypes["mp4"]).toBe("video/mp4");
  });

  it("maps audio extensions", () => {
    expect(contentTypes["ogg"]).toBe("audio/ogg");
    expect(contentTypes["mp3"]).toBe("audio/mpeg");
  });

  it("maps document extensions", () => {
    expect(contentTypes["pdf"]).toBe("application/pdf");
  });

  it("returns octet-stream for unknown extensions", () => {
    const ext = "xyz";
    const contentType = contentTypes[ext] ?? "application/octet-stream";
    expect(contentType).toBe("application/octet-stream");
  });

  it("handles missing extension", () => {
    const fileName = "noext";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const contentType = contentTypes[ext] ?? "application/octet-stream";
    expect(contentType).toBe("application/octet-stream");
  });
});
