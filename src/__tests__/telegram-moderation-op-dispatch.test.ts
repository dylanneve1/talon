/**
 * Telegram `moderate` action — the `op` table.
 *
 * Pins what the switch used to carry implicitly: every op reaches the Bot
 * API method it owns, the user_id pre-check fires before the table is
 * consulted (with the op-prefixed error), the per-op validation errors are
 * unchanged, and an op nobody claims — unknown, empty, an Object.prototype
 * name — gets the same "Unknown moderation op" error.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const joinRequests = vi.hoisted(() => ({
  clearJoinRequest: vi.fn(),
  listJoinRequests: vi.fn(() => [{ userId: 7 }]),
}));
vi.mock("../frontend/telegram/join-requests.js", () => joinRequests);

import {
  MODERATION_OPS,
  OPS_NEEDING_USER,
  moderationHandlers,
} from "../frontend/telegram/actions/moderation/index.js";
import type { TelegramActionContext } from "../frontend/telegram/actions/types.js";

const API_METHODS = [
  "banChatMember",
  "unbanChatMember",
  "restrictChatMember",
  "promoteChatMember",
  "setChatAdministratorCustomTitle",
  "setChatPermissions",
  "createChatInviteLink",
  "revokeChatInviteLink",
  "approveChatJoinRequest",
  "declineChatJoinRequest",
  "setChatPhoto",
  "deleteChatPhoto",
  "unpinAllChatMessages",
  "leaveChat",
  "createForumTopic",
  "editForumTopic",
  "closeForumTopic",
  "reopenForumTopic",
  "deleteForumTopic",
] as const;

type Api = Record<(typeof API_METHODS)[number], ReturnType<typeof vi.fn>>;

function fakeContext(): { ctx: TelegramActionContext; api: Api } {
  const api = Object.fromEntries(
    API_METHODS.map((m) => [m, vi.fn(async () => ({}))]),
  ) as Api;
  api.createChatInviteLink.mockResolvedValue({
    invite_link: "https://t.me/+x",
  });
  api.createForumTopic.mockResolvedValue({ message_thread_id: 42 });
  const ctx = {
    bot: { api },
    InputFileClass: class {},
    botToken: "t",
    gateway: {},
    scheduledMessages: new Map(),
  } as unknown as TelegramActionContext;
  return { ctx, api };
}

const CHAT = -100123;

async function moderate(
  body: Record<string, unknown>,
  ctx: TelegramActionContext,
) {
  return moderationHandlers.moderate(
    { action: "moderate", ...body },
    CHAT,
    ctx,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MODERATION_OPS", () => {
  it("has a null prototype and exactly the documented ops", () => {
    expect(Object.getPrototypeOf(MODERATION_OPS)).toBeNull();
    expect(Object.keys(MODERATION_OPS).sort()).toEqual([
      "approve_join_request",
      "ban",
      "close_topic",
      "create_invite_link",
      "create_topic",
      "decline_join_request",
      "delete_chat_photo",
      "delete_topic",
      "demote",
      "edit_topic",
      "leave_chat",
      "list_join_requests",
      "mute",
      "promote",
      "reopen_topic",
      "revoke_invite_link",
      "set_admin_title",
      "set_chat_photo",
      "set_permissions",
      "unban",
      "unmute",
      "unpin_all",
    ]);
  });

  it("only names ops the table has as needing a user", () => {
    for (const op of OPS_NEEDING_USER)
      expect(MODERATION_OPS[op]).toBeTypeOf("function");
  });
});

describe("moderate", () => {
  it.each([
    [{ op: "ban", user_id: 5 }, "banChatMember", [CHAT, 5, expect.anything()]],
    [
      { op: "unban", user_id: 5 },
      "unbanChatMember",
      [CHAT, 5, { only_if_banned: true }],
    ],
    [
      { op: "mute", user_id: 5 },
      "restrictChatMember",
      [CHAT, 5, { can_send_messages: false }, expect.anything()],
    ],
    [
      { op: "unmute", user_id: 5 },
      "restrictChatMember",
      [CHAT, 5, expect.objectContaining({ can_send_messages: true })],
    ],
    [
      { op: "promote", user_id: 5 },
      "promoteChatMember",
      [CHAT, 5, expect.objectContaining({ can_manage_chat: true })],
    ],
    [
      { op: "demote", user_id: 5 },
      "promoteChatMember",
      [CHAT, 5, expect.objectContaining({ can_manage_chat: false })],
    ],
    [
      { op: "set_admin_title", user_id: 5, title: "Mod" },
      "setChatAdministratorCustomTitle",
      [CHAT, 5, "Mod"],
    ],
    [
      { op: "set_permissions", permissions: { send_messages: false } },
      "setChatPermissions",
      [CHAT, { can_send_messages: false }],
    ],
    [
      { op: "create_invite_link" },
      "createChatInviteLink",
      [CHAT, expect.anything()],
    ],
    [
      { op: "revoke_invite_link", link: "https://t.me/+x" },
      "revokeChatInviteLink",
      [CHAT, "https://t.me/+x"],
    ],
    [
      { op: "approve_join_request", user_id: 5 },
      "approveChatJoinRequest",
      [CHAT, 5],
    ],
    [
      { op: "decline_join_request", user_id: 5 },
      "declineChatJoinRequest",
      [CHAT, 5],
    ],
    [{ op: "delete_chat_photo" }, "deleteChatPhoto", [CHAT]],
    [{ op: "unpin_all" }, "unpinAllChatMessages", [CHAT]],
    [{ op: "leave_chat" }, "leaveChat", [CHAT]],
    [{ op: "create_topic", title: "News" }, "createForumTopic", [CHAT, "News"]],
    [
      { op: "edit_topic", thread_id: 9, title: "Old news" },
      "editForumTopic",
      [CHAT, 9, { name: "Old news" }],
    ],
    [{ op: "close_topic", thread_id: 9 }, "closeForumTopic", [CHAT, 9]],
    [{ op: "reopen_topic", thread_id: 9 }, "reopenForumTopic", [CHAT, 9]],
    [{ op: "delete_topic", thread_id: 9 }, "deleteForumTopic", [CHAT, 9]],
  ] as const)("%o calls %s", async (body, method, args) => {
    const { ctx, api } = fakeContext();
    const result = await moderate({ ...body }, ctx);
    expect(result).toMatchObject({ ok: true });
    expect(api[method]).toHaveBeenCalledTimes(1);
    expect(api[method]).toHaveBeenCalledWith(...args);
    for (const other of API_METHODS) {
      if (other !== method) expect(api[other]).not.toHaveBeenCalled();
    }
  });

  it("returns the cached join requests without an API call", async () => {
    const { ctx, api } = fakeContext();
    const result = await moderate({ op: "list_join_requests" }, ctx);
    expect(result).toEqual({ ok: true, requests: [{ userId: 7 }] });
    expect(joinRequests.listJoinRequests).toHaveBeenCalledWith(CHAT);
    for (const m of API_METHODS) expect(api[m]).not.toHaveBeenCalled();
  });

  it("surfaces the invite link and the new topic id", async () => {
    const { ctx } = fakeContext();
    expect(await moderate({ op: "create_invite_link" }, ctx)).toEqual({
      ok: true,
      invite_link: "https://t.me/+x",
    });
    expect(await moderate({ op: "create_topic", title: "T" }, ctx)).toEqual({
      ok: true,
      thread_id: 42,
    });
  });

  it.each(OPS_NEEDING_USER)(
    "%s without a user_id fails before the table is consulted",
    async (op) => {
      const { ctx, api } = fakeContext();
      const result = await moderate({ op }, ctx);
      expect(result).toEqual({
        ok: false,
        error: `${op}: user_id is required`,
      });
      for (const m of API_METHODS) expect(api[m]).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ op: "set_permissions" }, "set_permissions: permissions required"],
    [{ op: "revoke_invite_link" }, "revoke_invite_link: link required"],
    [{ op: "create_topic" }, "create_topic: title required"],
    [{ op: "edit_topic" }, "edit_topic: thread_id required"],
    [{ op: "close_topic" }, "close_topic: thread_id required"],
    [{ op: "reopen_topic" }, "reopen_topic: thread_id required"],
    [{ op: "delete_topic" }, "delete_topic: thread_id required"],
    [
      { op: "set_chat_photo", file_id: "abc" },
      "set_chat_photo needs a local file_path (no url/file_id)",
    ],
  ])("%o keeps its validation error", async (body, error) => {
    const { ctx, api } = fakeContext();
    expect(await moderate({ ...body }, ctx)).toEqual({ ok: false, error });
    for (const m of API_METHODS) expect(api[m]).not.toHaveBeenCalled();
  });

  it.each(["nope", "", "constructor", "toString", "__proto__"])(
    "rejects unknown op %j",
    async (op) => {
      const { ctx, api } = fakeContext();
      const result = await moderate({ op }, ctx);
      expect(result).toEqual({
        ok: false,
        error: `Unknown moderation op: ${op}`,
      });
      for (const m of API_METHODS) expect(api[m]).not.toHaveBeenCalled();
    },
  );

  it("treats a missing op as the empty string", async () => {
    const { ctx } = fakeContext();
    expect(await moderate({}, ctx)).toEqual({
      ok: false,
      error: "Unknown moderation op: ",
    });
  });
});
