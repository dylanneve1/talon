import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const sendUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(42));
const sendUserbotTypingMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const editUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const deleteUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const reactUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearUserbotReactionsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const pinUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const unpinUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const forwardUserbotMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(77));
const sendUserbotFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(42));
const getUserbotEntityMock = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 123n }));
const getUserbotAdminsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const getUserbotMemberCountMock = vi.hoisted(() => vi.fn().mockResolvedValue(5));
const searchMessagesMock = vi.hoisted(() => vi.fn().mockResolvedValue("search results"));
const getHistoryMock = vi.hoisted(() => vi.fn().mockResolvedValue("history text"));
const getParticipantDetailsMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const getUserInfoMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const getMessageMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const getPinnedMessagesMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const getOnlineCountMock = vi.hoisted(() => vi.fn().mockResolvedValue(0));
const downloadMessageMediaMock = vi.hoisted(() => vi.fn().mockResolvedValue("/tmp/file.jpg"));
const getClientMock = vi.hoisted(() =>
  vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({}) }),
);
const isUserClientReadyMock = vi.hoisted(() => vi.fn().mockReturnValue(true));

const statSyncMock = vi.hoisted(() => vi.fn().mockReturnValue({ size: 100 }));
const readFileSyncMock = vi.hoisted(() => vi.fn().mockReturnValue(Buffer.from("test")));

const userbotMockExports = {
  isUserClientReady: isUserClientReadyMock,
  sendUserbotMessage: sendUserbotMessageMock,
  sendUserbotTyping: sendUserbotTypingMock,
  editUserbotMessage: editUserbotMessageMock,
  deleteUserbotMessage: deleteUserbotMessageMock,
  reactUserbotMessage: reactUserbotMessageMock,
  clearUserbotReactions: clearUserbotReactionsMock,
  pinUserbotMessage: pinUserbotMessageMock,
  unpinUserbotMessage: unpinUserbotMessageMock,
  forwardUserbotMessage: forwardUserbotMessageMock,
  sendUserbotFile: sendUserbotFileMock,
  getUserbotEntity: getUserbotEntityMock,
  getUserbotAdmins: getUserbotAdminsMock,
  getUserbotMemberCount: getUserbotMemberCountMock,
  searchMessages: searchMessagesMock,
  getHistory: getHistoryMock,
  getParticipantDetails: getParticipantDetailsMock,
  getUserInfo: getUserInfoMock,
  getMessage: getMessageMock,
  getPinnedMessages: getPinnedMessagesMock,
  getOnlineCount: getOnlineCountMock,
  downloadMessageMedia: downloadMessageMediaMock,
  getClient: getClientMock,
};

vi.mock("../frontend/telegram/userbot.js", () => userbotMockExports);
vi.mock("../frontend/telegram/userbot/client.js", () => userbotMockExports);

vi.mock("../core/gateway.js", () => ({
  withRetry: vi.fn().mockImplementation((fn: () => unknown) => fn()),
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  statSync: statSyncMock,
}));

// telegram/client/uploads.js and telegram (Api) are used internally but we
// let them import from the real package; we only care about behaviour via the
// mocked userbot functions.

// ── Dynamic import ────────────────────────────────────────────────────────────

const { createUserbotActionHandler } = await import(
  "../frontend/telegram/userbot-actions.js"
);

// ── Shared test setup ─────────────────────────────────────────────────────────

const CHAT_ID = 123456;

function makeHandler() {
  const recordOurMessage = vi.fn();
  const mockGateway: any = {
    incrementMessages: vi.fn(),
    getPort: vi.fn().mockReturnValue(19876),
  };
  const handle = createUserbotActionHandler(mockGateway, recordOurMessage);
  const call = (action: string, extra: Record<string, unknown> = {}) =>
    handle({ action, ...extra }, CHAT_ID);
  return { handle, call, mockGateway, recordOurMessage };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createUserbotActionHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendUserbotMessageMock.mockResolvedValue(42);
    forwardUserbotMessageMock.mockResolvedValue(77);
    sendUserbotFileMock.mockResolvedValue(42);
    getUserbotAdminsMock.mockResolvedValue([]);
    getUserbotMemberCountMock.mockResolvedValue(5);
    getHistoryMock.mockResolvedValue("history text");
    searchMessagesMock.mockResolvedValue("search results");
  });

  it("send_message calls sendUserbotMessage with text and returns ok with message_id", async () => {
    const { call } = makeHandler();
    const result = await call("send_message", { text: "hello world" });
    expect(sendUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, "hello world", undefined);
    expect(result).toMatchObject({ ok: true, message_id: 42 });
  });

  it("send_message calls recordOurMessage with chatId and msgId", async () => {
    const { call, recordOurMessage } = makeHandler();
    await call("send_message", { text: "track me" });
    expect(recordOurMessage).toHaveBeenCalledWith(String(CHAT_ID), 42);
  });

  it("react calls reactUserbotMessage and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("react", { message_id: 55, emoji: "🔥" });
    expect(reactUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, 55, "🔥");
    expect(result).toMatchObject({ ok: true });
  });

  it("clear_reactions calls clearUserbotReactions and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("clear_reactions", { message_id: 55 });
    expect(clearUserbotReactionsMock).toHaveBeenCalledWith(CHAT_ID, 55);
    expect(result).toMatchObject({ ok: true });
  });

  it("edit_message calls editUserbotMessage and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("edit_message", { message_id: 55, text: "updated" });
    expect(editUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, 55, "updated");
    expect(result).toMatchObject({ ok: true });
  });

  it("delete_message calls deleteUserbotMessage and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("delete_message", { message_id: 55 });
    expect(deleteUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, 55);
    expect(result).toMatchObject({ ok: true });
  });

  it("pin_message calls pinUserbotMessage and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("pin_message", { message_id: 55 });
    expect(pinUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, 55);
    expect(result).toMatchObject({ ok: true });
  });

  it("unpin_message calls unpinUserbotMessage and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("unpin_message", { message_id: 55 });
    expect(unpinUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, 55);
    expect(result).toMatchObject({ ok: true });
  });

  it("forward_message calls forwardUserbotMessage and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("forward_message", { message_id: 55 });
    expect(forwardUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, 55);
    expect(result).toMatchObject({ ok: true, message_id: 77 });
  });

  it("send_chat_action calls sendUserbotTyping and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("send_chat_action");
    expect(sendUserbotTypingMock).toHaveBeenCalledWith(CHAT_ID);
    expect(result).toMatchObject({ ok: true });
  });

  it("send_file calls sendUserbotFile with file path and returns ok with message_id", async () => {
    const { call } = makeHandler();
    const result = await call("send_file", {
      file_path: "/tmp/doc.pdf",
      caption: "Here's a doc",
    });
    expect(sendUserbotFileMock).toHaveBeenCalled();
    const callArgs = sendUserbotFileMock.mock.calls[0][1];
    expect(callArgs.filePath).toBe("/tmp/doc.pdf");
    expect(callArgs.caption).toBe("Here's a doc");
    expect(result).toMatchObject({ ok: true, message_id: 42 });
  });

  it("send_sticker returns ok:false (not supported in userbot mode)", async () => {
    const { call } = makeHandler();
    const result = await call("send_sticker", { file_id: "some_id" });
    expect(result).toMatchObject({ ok: false });
    expect((result as any).error).toBeTruthy();
  });

  it("send_message_with_buttons sends plain text with note and returns ok", async () => {
    const { call } = makeHandler();
    const result = await call("send_message_with_buttons", {
      text: "Pick one",
      buttons: [["A", "B"]],
    });
    expect(sendUserbotMessageMock).toHaveBeenCalledWith(CHAT_ID, "Pick one");
    expect(result).toMatchObject({ ok: true });
    expect((result as any).warning).toBeTruthy();
  });

  it("unknown action returns null", async () => {
    const { call } = makeHandler();
    const result = await call("totally_unknown_action");
    expect(result).toBeNull();
  });

  it("read_history returns result from getHistory", async () => {
    const { call } = makeHandler();
    const result = await call("read_history", { limit: 10 });
    expect(getHistoryMock).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, text: "history text" });
  });

  it("search_history returns result from searchMessages", async () => {
    const { call } = makeHandler();
    const result = await call("search_history", { query: "hello" });
    expect(searchMessagesMock).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, text: "search results" });
  });

  it("get_chat_member_count returns count", async () => {
    const { call } = makeHandler();
    const result = await call("get_chat_member_count");
    expect(getUserbotMemberCountMock).toHaveBeenCalledWith(CHAT_ID);
    expect(result).toMatchObject({ ok: true, count: 5 });
  });

  it("get_chat_admins returns admins array", async () => {
    getUserbotAdminsMock.mockResolvedValue(["@admin1", "@admin2"]);
    const { call } = makeHandler();
    const result = await call("get_chat_admins");
    expect(getUserbotAdminsMock).toHaveBeenCalledWith(CHAT_ID);
    expect(result).toMatchObject({ ok: true });
  });

  // ── New action cases ─────────────────────────────────────────────────────────

  it("get_join_requests calls GetChatInviteImporters and returns requests", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      importers: [{ userId: 999, date: 1700000000, about: "Please let me in" }],
      users: [{ id: 999, firstName: "Alice", lastName: "Test" }],
    });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("get_join_requests") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.requests[0].user_id).toBe(999);
    expect(result.requests[0].name).toBe("Alice Test");
  });

  it("approve_join_request calls HideChatJoinRequest with approved:true", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("approve_join_request", { user_id: 999 }) as any;
    expect(result.ok).toBe(true);
    expect(result.approved).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ approved: true }));
  });

  it("decline_join_request calls HideChatJoinRequest with approved:false", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("decline_join_request", { user_id: 999 }) as any;
    expect(result.ok).toBe(true);
    expect(result.approved).toBe(false);
  });

  it("approve_join_request returns error when user_id missing", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("approve_join_request") as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/user_id/);
  });

  it("set_auto_delete calls SetHistoryTTL with correct period", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_auto_delete", { seconds: 86400 }) as any;
    expect(result.ok).toBe(true);
    expect(result.seconds).toBe(86400);
    expect(result.label).toBe("1 day");
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ period: 86400 }));
  });

  it("set_auto_delete rejects invalid seconds value", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_auto_delete", { seconds: 999 }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/seconds must be/);
  });

  it("set_auto_delete with 0 turns off TTL", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_auto_delete", { seconds: 0 }) as any;
    expect(result.ok).toBe(true);
    expect(result.label).toBe("off");
  });

  it("set_protected_content calls ToggleNoForwards and returns ok", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_protected_content", { enabled: true }) as any;
    expect(result.ok).toBe(true);
    expect(result.protected_content).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("set_protected_content with enabled:false disables protection", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_protected_content", { enabled: false }) as any;
    expect(result.ok).toBe(true);
    expect(result.protected_content).toBe(false);
  });

  it("resolve_peer returns entity info for a username", async () => {
    getClientMock.mockReturnValue({
      getEntity: vi.fn().mockResolvedValue({
        className: "User",
        id: 12345n,
        firstName: "Alice",
        lastName: "Smith",
        username: "alicesmith",
        phone: null,
        bot: false,
        verified: true,
      }),
    });
    const { call } = makeHandler();
    const result = await call("resolve_peer", { query: "@alicesmith" }) as any;
    expect(result.ok).toBe(true);
    expect(result.type).toBe("user");
    expect(result.username).toBe("alicesmith");
    expect(result.verified).toBe(true);
    expect(result.id).toBe(12345);
  });

  it("resolve_peer returns error when entity not found", async () => {
    getClientMock.mockReturnValue({
      getEntity: vi.fn().mockRejectedValue(new Error("Not found")),
    });
    const { call } = makeHandler();
    const result = await call("resolve_peer", { query: "@doesnotexist" }) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not resolve/);
  });

  it("get_scheduled_messages returns message list", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      messages: [
        { id: 101, date: 1800000000, message: "Hello future" },
        { id: 102, date: 1900000000, message: "Another scheduled" },
      ],
    });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("get_scheduled_messages") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.text).toContain("Hello future");
  });

  it("delete_scheduled_message calls DeleteScheduledMessages", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("delete_scheduled_message", { message_id: 101 }) as any;
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(1);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ id: [101] }));
  });

  it("delete_scheduled_message supports array of IDs", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("delete_scheduled_message", { message_id: [101, 102, 103] }) as any;
    expect(result.ok).toBe(true);
    expect(result.deleted).toBe(3);
  });

  it("close_forum_topic calls EditForumTopic with closed:true", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("close_forum_topic", { topic_id: 5 }) as any;
    expect(result.ok).toBe(true);
    expect(result.closed).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ closed: true, topicId: 5 }));
  });

  it("reopen_forum_topic calls EditForumTopic with closed:false", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("reopen_forum_topic", { topic_id: 5 }) as any;
    expect(result.ok).toBe(true);
    expect(result.closed).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ closed: false, topicId: 5 }));
  });

  it("close_forum_topic returns error when topic_id missing", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("close_forum_topic") as any;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/topic_id/);
  });

  it("get_poll_results returns vote breakdown", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      updates: [{
        className: "UpdateMessagePoll",
        poll: {
          question: { text: "Best lang?" },
          answers: [{ text: { text: "Rust" } }, { text: { text: "Go" } }],
          closed: false,
        },
        results: {
          totalVoters: 10,
          results: [
            { voters: 7, chosen: true },
            { voters: 3, chosen: false },
          ],
        },
      }],
    });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("get_poll_results", { message_id: 200 }) as any;
    expect(result.ok).toBe(true);
    expect(result.total_voters).toBe(10);
    expect(result.options).toHaveLength(2);
    expect(result.options[0].text).toBe("Rust");
    expect(result.options[0].votes).toBe(7);
    expect(result.options[0].percentage).toBe(70);
    expect(result.options[0].you_voted).toBe(true);
    expect(result.options[1].votes).toBe(3);
  });

  it("list_media returns media messages by type", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      messages: [
        { id: 50, date: 1700000000, media: { className: "MessageMediaPhoto" }, message: "" },
        { id: 51, date: 1700001000, media: { className: "MessageMediaPhoto" }, message: "nice pic" },
      ],
    });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("list_media", { type: "photo", limit: 10 }) as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.type).toBe("photo");
  });

  it("mark_mentions_read calls ReadMentions", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ pts: 100, ptsCount: 5 });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("mark_mentions_read") as any;
    expect(result.ok).toBe(true);
    expect(result.pts).toBe(100);
  });

  it("mark_reactions_read calls ReadReactions", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ pts: 200, ptsCount: 3 });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("mark_reactions_read") as any;
    expect(result.ok).toBe(true);
    expect(result.pts).toBe(200);
  });

  it("get_connection_status returns connected:false when no client", async () => {
    getClientMock.mockReturnValue(null);
    const { call } = makeHandler();
    const result = await call("get_connection_status") as any;
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(false);
    expect(result.authorized).toBe(false);
  });

  it("get_connection_status returns authorized and self when connected", async () => {
    getClientMock.mockReturnValue({
      isUserAuthorized: vi.fn().mockResolvedValue(true),
      getMe: vi.fn().mockResolvedValue({ id: 12345n, username: "me", firstName: "Me", phone: "123" }),
      session: { dcId: 2 },
    });
    const { call } = makeHandler();
    const result = await call("get_connection_status") as any;
    expect(result.ok).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.authorized).toBe(true);
    expect(result.dc_id).toBe(2);
    expect(result.self?.username).toBe("me");
  });

  it("forward_messages_bulk forwards all IDs to target", async () => {
    const forwardMessagesMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ forwardMessages: forwardMessagesMock });
    const { call } = makeHandler();
    const result = await call("forward_messages_bulk", {
      message_ids: [1, 2, 3],
      to: "123456789",
    }) as any;
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(3);
    expect(forwardMessagesMock).toHaveBeenCalledWith(123456789, expect.objectContaining({ messages: [1, 2, 3] }));
  });

  it("clear_chat_history calls DeleteHistory", async () => {
    const invokeMock = vi.fn().mockResolvedValue({ pts: 500 });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("clear_chat_history", { revoke: false }) as any;
    expect(result.ok).toBe(true);
    expect(result.pts).toBe(500);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ maxId: 0, revoke: false }));
  });

  it("get_profile_photos returns photo list", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      photos: [
        { id: 1001n, date: 1700000000 },
        { id: 1002n, date: 1700001000 },
      ],
    });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("get_profile_photos") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(result.photos[0].id).toBe("1001");
  });

  it("get_similar_channels returns channel list", async () => {
    const invokeMock = vi.fn().mockResolvedValue({
      chats: [
        { id: 9999n, title: "Similar Chat", username: "simchat", participantsCount: 500 },
      ],
    });
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("get_similar_channels") as any;
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.text).toContain("Similar Chat");
    expect(result.text).toContain("500 members");
  });

  it("set_channel_username calls UpdateUsername", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_channel_username", { username: "newname" }) as any;
    expect(result.ok).toBe(true);
    expect(result.username).toBe("newname");
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ username: "newname" }));
  });

  it("set_channel_username with empty string removes username", async () => {
    const invokeMock = vi.fn().mockResolvedValue({});
    getClientMock.mockReturnValue({ invoke: invokeMock });
    const { call } = makeHandler();
    const result = await call("set_channel_username", { username: "" }) as any;
    expect(result.ok).toBe(true);
    expect(result.username).toBeNull();
  });
});
