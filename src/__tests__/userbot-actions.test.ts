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

vi.mock("../frontend/telegram/userbot.js", () => ({
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
}));

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
});
