/**
 * A blocked sender must be dropped in silence: no warning reply to them, no
 * notification to the admin, in DMs and in groups alike.
 *
 * The regression this guards against is subtle — the whitelist already stops
 * an unknown sender being acted on, so a broken denylist looks fine from the
 * outside. What gives it away is the reply and the admin ping, which is
 * exactly what these tests assert on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bot, Context } from "grammy";
import {
  setAccessControl,
  isAccessAllowed,
} from "../frontend/telegram/handlers/access.js";
import { accessConfig } from "../frontend/telegram/handlers/state.js";

const ADMIN = 111;
const BLOCKED = 7697235358;
const STRANGER = 999;

function makeBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getChatMember: vi.fn().mockResolvedValue({ status: "member" }),
    },
  } as unknown as Bot;
}

function makeCtx(fromId: number, chatType = "private") {
  return {
    chat: { id: fromId, type: chatType },
    from: { id: fromId, first_name: "Test", username: "test" },
    message: { text: "hello", message_id: 1 },
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Context;
}

describe("blocked users", () => {
  beforeEach(() => {
    setAccessControl({
      allowedUsers: [ADMIN],
      blockedUsers: [BLOCKED],
      adminUserId: ADMIN,
    });
  });

  it("registers the denylist", () => {
    expect(accessConfig.blockedUserIds?.has(BLOCKED)).toBe(true);
  });

  it("drops a blocked DM without replying or notifying", async () => {
    const bot = makeBot();
    const ctx = makeCtx(BLOCKED);
    expect(await isAccessAllowed(ctx, bot)).toBe(false);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("drops a blocked user in a group too", async () => {
    const bot = makeBot();
    const ctx = makeCtx(BLOCKED, "supergroup");
    expect(await isAccessAllowed(ctx, bot)).toBe(false);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("still allows the admin", async () => {
    const bot = makeBot();
    expect(await isAccessAllowed(makeCtx(ADMIN), bot)).toBe(true);
  });

  it("leaves normal unauthorized handling alone for anyone not blocked", async () => {
    const bot = makeBot();
    const ctx = makeCtx(STRANGER);
    expect(await isAccessAllowed(ctx, bot)).toBe(false);
    // Not blocked, merely unauthorized — the existing warn/notify path runs.
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });

  it("is inert when no denylist is configured", async () => {
    setAccessControl({ allowedUsers: [ADMIN], adminUserId: ADMIN });
    expect(accessConfig.blockedUserIds).toBeNull();
    const bot = makeBot();
    const ctx = makeCtx(BLOCKED);
    expect(await isAccessAllowed(ctx, bot)).toBe(false);
    expect(bot.api.sendMessage).toHaveBeenCalled();
  });
});
