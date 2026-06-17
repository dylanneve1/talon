/**
 * Tests for the runtime tap layer: bot-message attribution, the reaction tap,
 * and directive/correction classification. The taps must be inert no-ops when
 * the soul is disabled and only act on messages addressed to / authored by Talon.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SoulService, setSoul, resetSoul } from "../core/soul/service.js";
import {
  BOT_MESSAGE_ACTIONS,
  classifyMessage,
  isBotMessage,
  newlyAddedEmojis,
  noteBotMessage,
  recordMessageSignal,
  recordReactionToBot,
  resetBotMessages,
} from "../core/soul/taps.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "soul-taps-")), "soul.json");
}

function enableSoul(): void {
  setSoul(SoulService.create({ enabled: true, path: tmpPath() }));
}

afterEach(() => {
  resetSoul();
  resetBotMessages();
});

// ── Classification ───────────────────────────────────────────────────────────

describe("classifyMessage", () => {
  it("recognizes corrections", () => {
    expect(classifyMessage("No, that's wrong.")).toBe("correction");
    expect(classifyMessage("that's incorrect")).toBe("correction");
    expect(classifyMessage("you're wrong about that")).toBe("correction");
    expect(classifyMessage("that is not what I asked")).toBe("correction");
    expect(classifyMessage("never do that again")).toBe("correction");
    expect(classifyMessage("nope, try again")).toBe("correction");
  });

  it("recognizes directives", () => {
    expect(classifyMessage("From now on, keep it short.")).toBe("directive");
    expect(classifyMessage("going forward use metric units")).toBe("directive");
    expect(classifyMessage("you should never use emoji here")).toBe(
      "directive",
    );
    expect(classifyMessage("always check the palace first")).toBe("directive");
    expect(classifyMessage("I want you to be more concise")).toBe("directive");
    expect(classifyMessage("make sure you reply in the chat")).toBe(
      "directive",
    );
  });

  it("prefers correction over directive when both could match", () => {
    // "never do that" is a correction cue; classification checks corrections first
    expect(classifyMessage("no, never do that")).toBe("correction");
  });

  it("returns null for ordinary chat", () => {
    expect(classifyMessage("what's the weather like?")).toBe(null);
    expect(classifyMessage("haha nice one")).toBe(null);
    expect(classifyMessage("can you check the flights to Nice")).toBe(null);
    expect(classifyMessage("")).toBe(null);
  });

  it("ignores very long messages", () => {
    const long = "from now on " + "x".repeat(600);
    expect(classifyMessage(long)).toBe(null);
  });
});

// ── Reaction diffing ─────────────────────────────────────────────────────────

describe("newlyAddedEmojis", () => {
  it("returns emojis present in next but not prev", () => {
    expect(newlyAddedEmojis([], [{ type: "emoji", emoji: "🔥" }])).toEqual([
      "🔥",
    ]);
    expect(
      newlyAddedEmojis(
        [{ type: "emoji", emoji: "🔥" }],
        [
          { type: "emoji", emoji: "🔥" },
          { type: "emoji", emoji: "👍" },
        ],
      ),
    ).toEqual(["👍"]);
  });

  it("ignores custom and paid reactions", () => {
    expect(
      newlyAddedEmojis(
        [],
        [
          { type: "custom_emoji" },
          { type: "paid" },
          { type: "emoji", emoji: "❤" },
        ],
      ),
    ).toEqual(["❤"]);
  });

  it("returns empty when nothing was added", () => {
    expect(
      newlyAddedEmojis(
        [{ type: "emoji", emoji: "🔥" }],
        [{ type: "emoji", emoji: "🔥" }],
      ),
    ).toEqual([]);
    expect(newlyAddedEmojis([{ type: "emoji", emoji: "🔥" }], [])).toEqual([]);
  });
});

// ── Bot-message memory ───────────────────────────────────────────────────────

describe("bot-message memory", () => {
  it("does not track anything when the soul is disabled", () => {
    setSoul(SoulService.create({ enabled: false }));
    noteBotMessage("chat1", 10);
    expect(isBotMessage("chat1", 10)).toBe(false);
  });

  it("tracks and recognizes bot messages when enabled", () => {
    enableSoul();
    noteBotMessage("chat1", 10);
    noteBotMessage("chat1", 11);
    expect(isBotMessage("chat1", 10)).toBe(true);
    expect(isBotMessage("chat1", 11)).toBe(true);
    expect(isBotMessage("chat1", 99)).toBe(false);
    expect(isBotMessage("chat2", 10)).toBe(false);
  });

  it("ignores invalid ids and dedupes", () => {
    enableSoul();
    noteBotMessage("c", 0);
    noteBotMessage("c", -5);
    expect(isBotMessage("c", 0)).toBe(false);
    noteBotMessage("c", 7);
    noteBotMessage("c", 7);
    expect(isBotMessage("c", 7)).toBe(true);
  });

  it("bounds the ring so old ids are forgotten", () => {
    enableSoul();
    for (let i = 1; i <= 250; i++) noteBotMessage("c", i);
    // ring caps at 200, so the earliest ids fall off
    expect(isBotMessage("c", 1)).toBe(false);
    expect(isBotMessage("c", 250)).toBe(true);
  });
});

// ── Reaction tap ─────────────────────────────────────────────────────────────

describe("recordReactionToBot", () => {
  it("is a no-op when disabled", () => {
    setSoul(SoulService.create({ enabled: false }));
    expect(recordReactionToBot("c", 1, ["🔥"])).toBe(false);
  });

  it("only credits reactions on tracked bot messages", () => {
    enableSoul();
    expect(recordReactionToBot("c", 1, ["🔥"])).toBe(false); // not a bot msg
    noteBotMessage("c", 1);
    expect(recordReactionToBot("c", 1, ["🔥"])).toBe(true);
    expect(recordReactionToBot("c", 1, [])).toBe(false); // nothing added
  });
});

// ── Directive / correction tap ───────────────────────────────────────────────

describe("recordMessageSignal", () => {
  it("is a no-op when disabled", () => {
    setSoul(SoulService.create({ enabled: false }));
    expect(
      recordMessageSignal({
        text: "from now on be terse",
        addressedToBot: true,
      }),
    ).toBe(null);
  });

  it("ignores messages not addressed to the bot", () => {
    enableSoul();
    expect(
      recordMessageSignal({
        text: "no, that's wrong",
        addressedToBot: false,
      }),
    ).toBe(null);
  });

  it("records corrections and directives addressed to the bot", () => {
    enableSoul();
    expect(
      recordMessageSignal({
        text: "no, that's wrong",
        actor: "dylan",
        addressedToBot: true,
      }),
    ).toBe("correction");
    expect(
      recordMessageSignal({
        text: "from now on keep it short",
        actor: "dylan",
        addressedToBot: true,
      }),
    ).toBe("directive");
    expect(recordMessageSignal({ text: "thanks!", addressedToBot: true })).toBe(
      null,
    );
  });
});

// ── Action allowlist ─────────────────────────────────────────────────────────

describe("BOT_MESSAGE_ACTIONS", () => {
  it("includes outgoing message actions and excludes mutating ones", () => {
    expect(BOT_MESSAGE_ACTIONS.has("send_message")).toBe(true);
    expect(BOT_MESSAGE_ACTIONS.has("reply_to")).toBe(true);
    expect(BOT_MESSAGE_ACTIONS.has("send_photo")).toBe(true);
    expect(BOT_MESSAGE_ACTIONS.has("react")).toBe(false);
    expect(BOT_MESSAGE_ACTIONS.has("edit_message")).toBe(false);
    expect(BOT_MESSAGE_ACTIONS.has("delete_message")).toBe(false);
  });
});
