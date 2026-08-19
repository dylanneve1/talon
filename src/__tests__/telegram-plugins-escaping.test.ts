/**
 * `/plugins` listing escaping.
 *
 * The listing escaped the plugin *name* but interpolated `version`,
 * `description`, and `frontends` raw into an HTML-parsed send. Those are
 * all author-supplied manifest fields, so a description as ordinary as
 * "R&D tools" or "<beta> helper" made Telegram reject the entire message
 * with 400 "can't parse entities" — one odd plugin takes down the whole
 * command rather than rendering one odd line.
 *
 * Same bug class as the model menu's status lines and the `/model` error
 * reply; this covers the plugin sink.
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
vi.mock("../core/mesh/index.js", () => ({
  getMeshService: vi.fn(() => null),
}));

const getLoadedPlugins = vi.hoisted(() => vi.fn());
vi.mock("../core/plugin/index.js", () => ({ getLoadedPlugins }));

import { registerInfoCommands } from "../frontend/telegram/commands/info.js";

function captureCommands(): Map<string, (ctx: unknown) => Promise<void>> {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const bot = {
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers.set(name, handler);
    },
  } as unknown as Bot;
  registerInfoCommands(bot);
  return handlers;
}

function makeCtx() {
  const replies: Array<{ text: string; opts?: { parse_mode?: string } }> = [];
  return {
    ctx: {
      chat: { id: -100123 },
      match: "",
      reply: async (text: string, opts?: { parse_mode?: string }) => {
        replies.push({ text, opts });
      },
    },
    replies,
  };
}

beforeEach(() => {
  getLoadedPlugins.mockReset();
});

describe("/plugins listing is HTML-safe", () => {
  it("escapes every author-supplied manifest field, not just the name", async () => {
    getLoadedPlugins.mockReturnValue([
      {
        plugin: {
          name: "R&D <tools>",
          version: "1.0-<beta>",
          description: "Ops & <diagnostics> helper",
          frontends: ["telegram<x>"],
          mcpServerPath: "/x",
        },
      },
    ]);

    const handlers = captureCommands();
    const { ctx, replies } = makeCtx();
    await handlers.get("plugins")!(ctx);

    expect(replies).toHaveLength(1);
    const text = replies[0]!.text;
    expect(replies[0]!.opts?.parse_mode).toBe("HTML");

    // No raw angle bracket from manifest data may survive. The only `<`
    // characters left should be the listing's own markup (<b>…</b>).
    expect(text).not.toContain("<tools>");
    expect(text).not.toContain("<beta>");
    expect(text).not.toContain("<diagnostics>");
    expect(text).not.toContain("telegram<x>");
    expect(text).toContain("&lt;beta&gt;");
    expect(text).toContain("&amp;");
    // The intended markup is still intact.
    expect(text).toContain("<b>");
  });

  it("renders an ordinary plugin unchanged", async () => {
    getLoadedPlugins.mockReturnValue([
      {
        plugin: {
          name: "brave-search",
          version: "2.1.0",
          description: "Web search",
          frontends: ["telegram"],
        },
      },
    ]);

    const handlers = captureCommands();
    const { ctx, replies } = makeCtx();
    await handlers.get("plugins")!(ctx);

    const text = replies[0]!.text;
    expect(text).toContain("brave-search");
    expect(text).toContain("v2.1.0");
    expect(text).toContain("Web search");
    expect(text).toContain("(telegram)");
  });

  it("still reports when nothing is loaded", async () => {
    getLoadedPlugins.mockReturnValue([]);
    const handlers = captureCommands();
    const { ctx, replies } = makeCtx();
    await handlers.get("plugins")!(ctx);
    expect(replies[0]!.text).toBe("No plugins loaded.");
  });
});
