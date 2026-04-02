/**
 * Tests for src/frontend/teams/graph.ts
 *
 * Covers: loadTokens, saveTokens, refreshAccessToken, GraphClient
 * (ensureValidToken, graphGet, getMe, listChats, getChatMessages,
 * getStoredChatId/ChatTopic/UserId, saveChatConfig), and initGraphClient.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted so mock factories can reference these before import hoisting
const {
  writeAtomicSyncMock,
  existsSyncMock,
  readFileSyncMock,
  mkdirSyncMock,
  proxyFetchMock,
} = vi.hoisted(() => ({
  writeAtomicSyncMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  proxyFetchMock: vi.fn(),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
}));
vi.mock("../util/paths.js", () => ({
  dirs: { data: "/fake/.talon/data" },
  files: {},
}));
vi.mock("write-file-atomic", () => ({
  default: { sync: writeAtomicSyncMock },
}));
vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));
vi.mock("../frontend/teams/proxy-fetch.js", () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}));
vi.mock("cheerio", () => {
  const dollarFn = Object.assign(vi.fn(), { text: () => "stripped text" });
  return {
    default: {},
    load: vi.fn(() => dollarFn),
  };
});
vi.mock("marked", () => ({
  marked: { lexer: vi.fn(() => []) },
}));

import { GraphClient, initGraphClient, deviceCodeAuth } from "../frontend/teams/graph.js";

// ── Helper: make a mock JSON response ────────────────────────────────────────

function mockResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn(async () => data),
    text: vi.fn(async () => JSON.stringify(data)),
  };
}

function makeTokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    ...overrides,
  };
}

// ── GraphClient ──────────────────────────────────────────────────────────────

describe("GraphClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    mkdirSyncMock.mockReturnValue(undefined);
  });

  describe("ensureValidToken", () => {
    it("returns existing token when not expired", async () => {
      const tokens = makeTokens(); // expires 1h from now
      const client = new GraphClient(tokens as ConstructorParameters<typeof GraphClient>[0]);

      proxyFetchMock.mockResolvedValue(mockResponse({ id: "user1", displayName: "Alice" }));
      const result = await client.getMe();
      expect(result.id).toBe("user1");
      // proxyFetch called with Bearer access-token
      expect(proxyFetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/me"),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer test-access-token" }) }),
      );
    });

    it("refreshes token when expired", async () => {
      const tokens = makeTokens({ expiresAt: Date.now() - 1000 }); // already expired
      const client = new GraphClient(tokens as ConstructorParameters<typeof GraphClient>[0]);

      // First call: refresh token endpoint
      // Second call: the actual graphGet
      proxyFetchMock
        .mockResolvedValueOnce(mockResponse({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }))
        .mockResolvedValueOnce(mockResponse({ id: "user1", displayName: "Alice" }));

      const result = await client.getMe();
      expect(result.id).toBe("user1");
      // The Bearer token in the second call should be the NEW token
      expect(proxyFetchMock.mock.calls[1]![1]!.headers.Authorization).toBe("Bearer new-access-token");
      // Tokens should be saved
      expect(writeAtomicSyncMock).toHaveBeenCalled();
    });

    it("throws when token refresh fails", async () => {
      const tokens = makeTokens({ expiresAt: Date.now() - 1000 });
      const client = new GraphClient(tokens as ConstructorParameters<typeof GraphClient>[0]);

      proxyFetchMock.mockResolvedValueOnce(mockResponse({
        error: "invalid_grant",
        error_description: "Token has been revoked",
      }));

      await expect(client.getMe()).rejects.toThrow("Token refresh failed");
    });

    it("uses error code when error_description is absent from refresh response", async () => {
      const tokens = makeTokens({ expiresAt: Date.now() - 1000 });
      const client = new GraphClient(tokens as ConstructorParameters<typeof GraphClient>[0]);

      proxyFetchMock.mockResolvedValueOnce(mockResponse({
        // error_description intentionally omitted → triggers (data.error_description || data.error)
        error: "expired_token",
      }));

      await expect(client.getMe()).rejects.toThrow("Token refresh failed");
    });

    it("uses existing refreshToken when response omits refresh_token", async () => {
      const originalRefreshToken = "original-refresh-token";
      const tokens = makeTokens({ expiresAt: Date.now() - 1000, refreshToken: originalRefreshToken });
      const client = new GraphClient(tokens as ConstructorParameters<typeof GraphClient>[0]);

      // First call: token refresh succeeds without providing new refresh_token
      proxyFetchMock
        .mockResolvedValueOnce(mockResponse({
          access_token: "new-access-token-2",
          // refresh_token intentionally omitted → triggers (data.refresh_token || refreshToken)
          expires_in: 3600,
        }))
        // Second call: the actual API request
        .mockResolvedValueOnce(mockResponse({ id: "user2", displayName: "User Two" }));

      const result = await client.getMe();
      expect(result.id).toBe("user2");
      // The saved tokens should use the original refresh token as fallback
      const savedData = JSON.parse(writeAtomicSyncMock.mock.calls[writeAtomicSyncMock.mock.calls.length - 1][1] as string);
      expect(savedData.refreshToken).toBe(originalRefreshToken);
    });
  });

  describe("graphGet", () => {
    it("throws on non-ok HTTP response", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue(mockResponse({ error: "Unauthorized" }, false, 401));
      await expect(client.getMe()).rejects.toThrow("Graph API");
      await expect(client.getMe()).rejects.toThrow("401");
    });

    it("covers () => '' catch callback when resp.text() throws on non-ok response", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn(async () => { throw new Error("body read failed"); }),
        json: vi.fn(async () => ({})),
      });
      // resp.text() throws → catch(() => "") fires → body = ""
      await expect(client.getMe()).rejects.toThrow("Graph API /me");
    });
  });

  describe("getMe", () => {
    it("returns user id and displayName", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue(mockResponse({ id: "abc123", displayName: "Bob Smith" }));
      const me = await client.getMe();
      expect(me.id).toBe("abc123");
      expect(me.displayName).toBe("Bob Smith");
    });
  });

  describe("listChats", () => {
    it("returns chats array with id, topic, chatType", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue(mockResponse({
        value: [
          { id: "chat1", topic: "Team discussion", chatType: "group" },
          { id: "chat2", topic: null, chatType: "oneOnOne" },
        ],
      }));
      const chats = await client.listChats();
      expect(chats).toHaveLength(2);
      expect(chats[0]!.id).toBe("chat1");
      expect(chats[0]!.topic).toBe("Team discussion");
      expect(chats[1]!.topic).toBeNull();
    });
  });

  describe("getChatMessages", () => {
    it("filters only 'message' type messages", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue(mockResponse({
        value: [
          {
            id: "msg1",
            messageType: "message",
            from: { user: { id: "u1", displayName: "Alice" } },
            body: { contentType: "text", content: "Hello there" },
            createdDateTime: "2026-01-01T10:00:00Z",
            lastEditedDateTime: null,
          },
          {
            id: "msg2",
            messageType: "systemEventMessage", // should be filtered out
            from: null,
            body: { contentType: "text", content: "User joined" },
            createdDateTime: "2026-01-01T09:00:00Z",
            lastEditedDateTime: null,
          },
        ],
      }));
      const messages = await client.getChatMessages("chat1");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.id).toBe("msg1");
      expect(messages[0]!.senderName).toBe("Alice");
      expect(messages[0]!.text).toBe("Hello there");
      expect(messages[0]!.edited).toBe(false);
    });

    it("marks message as edited when lastEditedDateTime is set", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue(mockResponse({
        value: [{
          id: "msg3",
          messageType: "message",
          from: { user: { id: "u2", displayName: "Bob" } },
          body: { contentType: "text", content: "edited msg" },
          createdDateTime: "2026-01-01T11:00:00Z",
          lastEditedDateTime: "2026-01-01T11:05:00Z",
        }],
      }));
      const messages = await client.getChatMessages("chat1");
      expect(messages[0]!.edited).toBe(true);
    });

    it("handles null from/user gracefully", async () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      proxyFetchMock.mockResolvedValue(mockResponse({
        value: [{
          id: "msg4",
          messageType: "message",
          from: null,
          body: { contentType: "text", content: "anon msg" },
          createdDateTime: "2026-01-01T12:00:00Z",
          lastEditedDateTime: null,
        }],
      }));
      const messages = await client.getChatMessages("chat1");
      expect(messages[0]!.senderName).toBe("Unknown");
      expect(messages[0]!.senderId).toBe("");
    });
  });

  describe("stored config helpers", () => {
    it("returns undefined for unset chatId/chatTopic/userId", () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      expect(client.getStoredChatId()).toBeUndefined();
      expect(client.getStoredChatTopic()).toBeUndefined();
      expect(client.getStoredUserId()).toBeUndefined();
    });

    it("saveChatConfig stores and returns config", () => {
      const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
      client.saveChatConfig("chat-abc", "My Team", "user-xyz");
      expect(client.getStoredChatId()).toBe("chat-abc");
      expect(client.getStoredChatTopic()).toBe("My Team");
      expect(client.getStoredUserId()).toBe("user-xyz");
      expect(writeAtomicSyncMock).toHaveBeenCalled();
    });
  });
});

// ── initGraphClient ──────────────────────────────────────────────────────────

describe("initGraphClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads stored tokens, refreshes, and returns GraphClient", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      accessToken: "old-token",
      refreshToken: "stored-refresh",
      expiresAt: Date.now() - 1000,
    }));

    proxyFetchMock.mockResolvedValue(mockResponse({
      access_token: "fresh-token",
      refresh_token: "new-refresh",
      expires_in: 3600,
    }));

    const client = await initGraphClient();
    expect(client).toBeInstanceOf(GraphClient);
    expect(writeAtomicSyncMock).toHaveBeenCalled();
  });

  it("falls through to deviceCodeAuth when no stored tokens", async () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(false);
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-code",
        user_code: "ABC-123",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1, // 1-second poll
        message: "Sign in at https://microsoft.com/devicelogin",
      }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "device-token",
        refresh_token: "device-refresh",
        expires_in: 3600,
      }));

    const promise = initGraphClient();
    await vi.advanceTimersByTimeAsync(1100);
    const client = await promise;
    expect(client).toBeInstanceOf(GraphClient);
    vi.useRealTimers();
  });

  it("falls back to deviceCodeAuth when stored refresh token fails", async () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify({
      accessToken: "old",
      refreshToken: "bad-refresh",
      expiresAt: Date.now() - 1000,
    }));

    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({ error: "invalid_grant", error_description: "token expired" }))
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc2",
        user_code: "XYZ-789",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "new-device-token",
        refresh_token: "new-device-refresh",
        expires_in: 3600,
      }));

    const promise = initGraphClient();
    await vi.advanceTimersByTimeAsync(1100);
    const client = await promise;
    expect(client).toBeInstanceOf(GraphClient);
    vi.useRealTimers();
  });
});

// ── loadTokens edge cases ──────────────────────────────────────────────────

describe("loadTokens (via initGraphClient)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles corrupt token file gracefully (falls back to deviceCodeAuth)", async () => {
    vi.useFakeTimers();
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("{ invalid json {{{{");

    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc3",
        user_code: "MNO-456",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "from-device",
        refresh_token: "from-device-refresh",
        expires_in: 3600,
      }));

    const promise = initGraphClient();
    await vi.advanceTimersByTimeAsync(1100);
    const client = await promise;
    expect(client).toBeInstanceOf(GraphClient);
    vi.useRealTimers();
  });
});

// ── deviceCodeAuth polling paths ─────────────────────────────────────────────

describe("deviceCodeAuth polling edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockReturnValue(undefined);
  });

  it("handles authorization_pending then succeeds", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-pending",
        user_code: "AAA-000",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "final-token",
        refresh_token: "final-refresh",
        expires_in: 3600,
      }));

    const promise = deviceCodeAuth();
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);
    const tokens = await promise;
    expect(tokens.accessToken).toBe("final-token");
    vi.useRealTimers();
  });

  it("handles slow_down response (waits extra 5s before continuing)", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-slow",
        user_code: "BBB-111",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({ error: "slow_down" }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "slow-down-token",
        refresh_token: "slow-down-refresh",
        expires_in: 3600,
      }));

    const promise = deviceCodeAuth();
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(5100);
    await vi.advanceTimersByTimeAsync(1100);
    const tokens = await promise;
    expect(tokens.accessToken).toBe("slow-down-token");
    vi.useRealTimers();
  });

  it("throws on permanent auth error (access_denied)", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-err",
        user_code: "CCC-222",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({
        error: "access_denied",
        error_description: "The user declined to authorize",
      }));

    const promise = deviceCodeAuth();
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const check = expect(promise).rejects.toThrow("Auth failed");
    await vi.advanceTimersByTimeAsync(1100);
    await check;
    vi.useRealTimers();
  });
});

// ── deviceCodeAuth — branch coverage ─────────────────────────────────────────

describe("deviceCodeAuth — branch coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockReturnValue(undefined);
  });

  it("uses default interval (5s) when response omits interval field", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-noint",
        user_code: "ZZZ-999",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        // interval intentionally omitted → triggers (dcResp.interval || 5)
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "default-interval-token",
        refresh_token: "ri",
        expires_in: 3600,
      }));

    const promise = deviceCodeAuth();
    // Default interval is 5s
    await vi.advanceTimersByTimeAsync(5100);
    const tokens = await promise;
    expect(tokens.accessToken).toBe("default-interval-token");
    vi.useRealTimers();
  });

  it("uses empty string when refresh_token is absent", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-norefresh",
        user_code: "YYY-888",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({
        access_token: "no-refresh-token",
        // refresh_token intentionally omitted → triggers (tokenResp.refresh_token || "")
        expires_in: 3600,
      }));

    const promise = deviceCodeAuth();
    await vi.advanceTimersByTimeAsync(1100);
    const tokens = await promise;
    expect(tokens.accessToken).toBe("no-refresh-token");
    expect(tokens.refreshToken).toBe("");
    vi.useRealTimers();
  });

  it("uses error code when error_description is absent", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-noerrdesc",
        user_code: "XXX-777",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 300,
        interval: 1,
        message: "Sign in",
      }))
      .mockResolvedValueOnce(mockResponse({
        // error_description omitted → triggers (tokenResp.error_description || tokenResp.error)
        error: "invalid_grant",
      }));

    const promise = deviceCodeAuth();
    const check = expect(promise).rejects.toThrow("Auth failed: invalid_grant");
    await vi.advanceTimersByTimeAsync(1100);
    await check;
    vi.useRealTimers();
  });
});

// ── getChatMessages HTML content type ─────────────────────────────────────────

describe("getChatMessages — HTML content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
  });

  it("strips HTML when contentType is html", async () => {
    const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
    proxyFetchMock.mockResolvedValue(mockResponse({
      value: [{
        id: "html-msg",
        messageType: "message",
        from: { user: { id: "u5", displayName: "Carol" } },
        body: { contentType: "html", content: "<p>Hello <b>Teams</b>!</p>" },
        createdDateTime: "2026-01-01T13:00:00Z",
        lastEditedDateTime: null,
      }],
    }));

    const messages = await client.getChatMessages("chat1");
    // stripHtml should have been invoked (mocked to return "stripped text")
    expect(messages[0]!.text).toBe("stripped text");
  });

  it("uses empty string when body content is null/empty", async () => {
    const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
    proxyFetchMock.mockResolvedValue(mockResponse({
      value: [{
        id: "empty-body-msg",
        messageType: "message",
        from: { user: { id: "u6", displayName: "Dave" } },
        body: { contentType: "text", content: "" }, // empty content → triggers || ""
        createdDateTime: "2026-01-01T14:00:00Z",
        lastEditedDateTime: null,
      }],
    }));

    const messages = await client.getChatMessages("chat1");
    expect(messages[0]!.text).toBe("");
  });

  it("handles null body gracefully", async () => {
    const client = new GraphClient(makeTokens() as ConstructorParameters<typeof GraphClient>[0]);
    proxyFetchMock.mockResolvedValue(mockResponse({
      value: [{
        id: "null-body-msg",
        messageType: "message",
        from: { user: { id: "u7", displayName: "Eve" } },
        body: null, // null body → triggers body?.content || ""
        createdDateTime: "2026-01-01T15:00:00Z",
        lastEditedDateTime: null,
      }],
    }));

    const messages = await client.getChatMessages("chat1");
    expect(messages[0]!.text).toBe("");
  });
});

describe("deviceCodeAuth — timeout path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
  });

  it("throws when device code auth deadline expires", async () => {
    vi.useFakeTimers();
    proxyFetchMock
      // device code request
      .mockResolvedValueOnce(mockResponse({
        device_code: "dc-to",
        user_code: "DDD-333",
        verification_uri: "https://microsoft.com/devicelogin",
        expires_in: 5, // 5-second deadline
        interval: 1,
        message: "Sign in",
      }))
      // Always return authorization_pending — loop runs until deadline
      .mockResolvedValue(mockResponse({ error: "authorization_pending" }));

    const promise = deviceCodeAuth();
    // Attach handler first to avoid unhandled rejection
    const check = expect(promise).rejects.toThrow("Device code auth timed out");
    // Advance past the 5-second deadline
    await vi.advanceTimersByTimeAsync(6100);
    await check;
    vi.useRealTimers();
  });
});
