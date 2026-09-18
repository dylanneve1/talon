/**
 * Registration order regression.
 *
 * `admin` installs the unknown-command catch-all on `message::bot_command`.
 * grammY dispatches middleware in registration order, so ANY command
 * registered after it is shadowed: typing it produces the absurd
 * "Unknown command /whatsapp — did you mean /whatsapp?" — which is
 * exactly what shipped when /whatsapp and /auth were appended after
 * registerAdminCommands.
 *
 * The discriminator: record the order of bot.command(...) vs the
 * bot.on("message::bot_command", ...) catch-all, and assert every command
 * the menu advertises is registered BEFORE it. This fails on the old
 * ordering and passes on the new one.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../core/update/self-update.js", () => ({
  getRepoRoot: () => "/repo",
  runSelfUpdate: vi.fn(),
}));

import { registerCommands } from "../frontend/telegram/commands/index.js";
import { telegramCommandMenu } from "../frontend/telegram/commands/definitions.js";
import type { Bot } from "grammy";
import type { TalonConfig } from "../core/config/index.js";

type Entry = { kind: "command" | "on"; key: string };

function recordingBot(): { bot: Bot; entries: Entry[] } {
  const entries: Entry[] = [];
  const bot = {
    command(name: string | string[]) {
      for (const n of Array.isArray(name) ? name : [name]) {
        entries.push({ kind: "command", key: n });
      }
      return bot;
    },
    on(filter: string) {
      entries.push({ kind: "on", key: filter });
      return bot;
    },
    use() {
      return bot;
    },
    callbackQuery() {
      return bot;
    },
  } as unknown as Bot;
  return { bot: bot as Bot, entries };
}

describe("telegram command registration order", () => {
  const config = { devBuild: true } as unknown as TalonConfig;

  it("registers every menu command before the unknown-command catch-all", () => {
    const { bot, entries } = recordingBot();
    registerCommands(bot, config);

    const catchAll = entries.findIndex(
      (e) => e.kind === "on" && e.key === "message::bot_command",
    );
    expect(catchAll).toBeGreaterThan(-1);

    const registered = new Map<string, number>();
    entries.forEach((e, i) => {
      if (e.kind === "command" && !registered.has(e.key)) {
        registered.set(e.key, i);
      }
    });

    const shadowed = telegramCommandMenu(config)
      .map((c) => c.command)
      .filter((name) => {
        const at = registered.get(name);
        return at !== undefined && at > catchAll;
      });

    expect(shadowed).toEqual([]);
  });

  it("registers /whatsapp and /auth at all", () => {
    const { bot, entries } = recordingBot();
    registerCommands(bot, config);
    const names = entries.filter((e) => e.kind === "command").map((e) => e.key);
    expect(names).toContain("whatsapp");
    expect(names).toContain("auth");
  });
});
