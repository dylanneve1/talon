/**
 * `/mesh` must not put bridge credentials into a group.
 *
 * The footer and the pairing block carry a bearer token and a certificate
 * fingerprint — everything needed to join the mesh and drive every device on
 * it. Access was gated on "is this the admin?" alone, which answers the wrong
 * question: the admin can type in a room full of people, and a Telegram group
 * message is readable by every member, forwardable out of the group, and kept
 * in their clients forever. Asking in a group leaked the key to the fleet to
 * everyone in it.
 *
 * Gate is now admin AND a 1:1 chat. `/mesh link` still mints for the admin
 * from a group, but delivers to their DM and leaves a receipt behind.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bot } from "grammy";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../frontend/telegram/userbot.js", () => ({
  isUserClientReady: vi.fn(() => false),
}));
vi.mock("../core/plugin/index.js", () => ({
  getLoadedPlugins: vi.fn(() => []),
}));

const TOKEN = "s3cr3t-bearer-token";
const FINGERPRINT = "a1eeb6400c2876bb";

const pingAll = vi.hoisted(() => vi.fn(async () => []));
const bridgeReachability = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true as const,
    url: "https://mesh.example.org:19880",
    authRequired: true,
    token: "s3cr3t-bearer-token",
    fingerprint: "a1eeb6400c2876bb",
  })),
);
const makeCompanionPairLink = vi.hoisted(() =>
  vi.fn(() => ({
    ok: true as const,
    link: "https://mesh.example.org:19880/pair?grant=GRANT",
    url: "https://mesh.example.org:19880",
    token: "s3cr3t-bearer-token",
    fingerprint: "a1eeb6400c2876bb",
  })),
);
vi.mock("../core/mesh/index.js", () => ({
  getMeshService: vi.fn(() => ({
    pingAll,
    bridgeReachability,
    makeCompanionPairLink,
  })),
}));

const isAuthorizedAdmin = vi.hoisted(() => vi.fn(() => true));
vi.mock("../frontend/telegram/commands/state.js", () => ({
  isAuthorizedAdmin,
}));

import { registerInfoCommands } from "../frontend/telegram/commands/info.js";

type Handler = (ctx: unknown) => Promise<void>;

function harness() {
  const handlers = new Map<string, Handler>();
  const edits: string[] = [];
  const dms: Array<{ chatId: number; text: string }> = [];
  const sendMessage = vi.fn(async (chatId: number, text: string) => {
    dms.push({ chatId, text });
    return { message_id: 2 };
  });
  const bot = {
    command: (name: string, handler: Handler) => handlers.set(name, handler),
    api: {
      sendMessage,
      editMessageText: async (_c: number, _m: number, text: string) => {
        edits.push(text);
      },
    },
  } as unknown as Bot;
  registerInfoCommands(bot);
  return { handlers, edits, dms, sendMessage };
}

function ctxFor(type: "private" | "supergroup", match = "") {
  const replies: string[] = [];
  return {
    ctx: {
      chat: { id: type === "private" ? 42 : -100123, type },
      from: { id: 42 },
      me: { first_name: "Talon" },
      match,
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 1 };
      },
    },
    replies,
  };
}

beforeEach(() => {
  isAuthorizedAdmin.mockReturnValue(true);
  makeCompanionPairLink.mockClear();
});

describe("/mesh keeps bridge credentials out of groups", () => {
  it("withholds the token from a group even when the admin asks", async () => {
    const { handlers, edits } = harness();
    const { ctx } = ctxFor("supergroup");

    await handlers.get("mesh")!(ctx);

    const report = edits.join("\n");
    expect(report).toContain("mesh.example.org");
    expect(report).toContain("token required");
    expect(report).not.toContain(TOKEN);
    expect(report).not.toContain(FINGERPRINT);
  });

  it("still gives the admin the whole profile in a DM", async () => {
    const { handlers, edits } = harness();
    const { ctx } = ctxFor("private");

    await handlers.get("mesh")!(ctx);

    const report = edits.join("\n");
    expect(report).toContain(TOKEN);
    expect(report).toContain(FINGERPRINT);
  });

  it("routes a pairing link asked for in a group to the admin's DM", async () => {
    const { handlers, dms } = harness();
    const { ctx, replies } = ctxFor("supergroup", "link Car");

    await handlers.get("mesh")!(ctx);

    expect(makeCompanionPairLink).toHaveBeenCalledWith("Car");
    expect(dms).toHaveLength(1);
    expect(dms[0]!.chatId).toBe(42);
    expect(dms[0]!.text).toContain("grant=GRANT");
    expect(replies.join("\n")).not.toContain(TOKEN);
    expect(replies.join("\n")).not.toContain("grant=GRANT");
  });

  it("says so rather than posting when the DM cannot be delivered", async () => {
    const { handlers, sendMessage } = harness();
    sendMessage.mockRejectedValueOnce(new Error("bot can't initiate"));
    const { ctx, replies } = ctxFor("supergroup", "link");

    await handlers.get("mesh")!(ctx);

    const said = replies.join("\n");
    expect(said).not.toContain(TOKEN);
    expect(said).not.toContain("grant=GRANT");
    expect(said).toMatch(/message me directly/i);
  });

  it("posts the pairing block inline in a DM", async () => {
    const { handlers, dms } = harness();
    const { ctx, replies } = ctxFor("private", "link");

    await handlers.get("mesh")!(ctx);

    expect(dms).toHaveLength(0);
    expect(replies.join("\n")).toContain("grant=GRANT");
  });
});
