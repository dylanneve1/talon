/**
 * Unit tests for the `end_turn` tool and the cross-tool dedup helpers used to
 * suppress duplicate deliveries when the model calls both `end_turn` and
 * `send(type="text")` with similar content in the same turn.
 *
 * Covers:
 *   - normalizeForDedupe / isDuplicateOfDelivered (dedup math)
 *   - end_turn tool definition (schema, dispatch, silent path)
 *   - StreamState carries lastTrailingText and deliveredTextNorms
 */

import { describe, it, expect, vi } from "vitest";
import {
  normalizeForDedupe,
  isDuplicateOfDelivered,
  createStreamState,
} from "../backend/claude-sdk/stream.js";
import { messagingTools } from "../core/tools/messaging.js";
import { isTurnTerminator, ALL_TOOLS } from "../core/tools/index.js";

describe("normalizeForDedupe", () => {
  it("trims, lowercases, and collapses whitespace", () => {
    expect(normalizeForDedupe("  Hello   World  ")).toBe("hello world");
    expect(normalizeForDedupe("HELLO\n\tWORLD")).toBe("hello world");
  });

  it("strips emoji so prose-with-emoji matches messaging-tool-text", () => {
    expect(normalizeForDedupe("Got it 👍")).toBe("got it");
    expect(normalizeForDedupe("Done ✅ and dusted")).toBe("done and dusted");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeForDedupe("   \n\t  ")).toBe("");
  });
});

describe("isDuplicateOfDelivered", () => {
  it("returns false when nothing has been delivered yet", () => {
    expect(isDuplicateOfDelivered("hello there", [])).toBe(false);
  });

  it("returns false for very short candidates (below dedup threshold)", () => {
    // Below MIN_DEDUP_LENGTH (10) — short replies like "ok" / "sure" should
    // never be deduped, even if they happened to coincide with a longer
    // delivered text containing them.
    expect(isDuplicateOfDelivered("ok", ["ok thanks pal"])).toBe(false);
  });

  it("matches when normalized candidate is a substring of delivered", () => {
    const delivered = [normalizeForDedupe("Got it sur, pushing now")];
    expect(isDuplicateOfDelivered("Got it sur, pushing now", delivered)).toBe(
      true,
    );
  });

  it("matches when normalized delivered is a substring of candidate", () => {
    // Model called end_turn(text="Pushing now") then wrote prose
    // "I'm pushing now and back in a sec." — fuzzy match catches this.
    const delivered = [normalizeForDedupe("Pushing now")];
    expect(
      isDuplicateOfDelivered("I'm pushing now and back in a sec.", delivered),
    ).toBe(true);
  });

  it("does not match unrelated content", () => {
    const delivered = [normalizeForDedupe("PR #106 merged")];
    expect(
      isDuplicateOfDelivered("Got it, I'll look at the docker logs", delivered),
    ).toBe(false);
  });

  it("ignores emoji differences when comparing", () => {
    // Model wrote "Done 🎉" as prose, also called end_turn(text="Done")
    const delivered = [normalizeForDedupe("Done")];
    expect(isDuplicateOfDelivered("Done 🎉", delivered)).toBe(false);
    // Above is false because "done" (3 chars) < MIN_DEDUP_LENGTH (10).
    // For a longer match:
    const longDelivered = [normalizeForDedupe("All set, pushing now")];
    expect(
      isDuplicateOfDelivered("All set, pushing now 🚀", longDelivered),
    ).toBe(true);
  });
});

describe("createStreamState", () => {
  it("initializes lastTrailingText and deliveredTextNorms", () => {
    const state = createStreamState();
    expect(state.lastTrailingText).toBe("");
    expect(state.deliveredTextNorms).toEqual([]);
  });

  it("initializes turnTerminated to false", () => {
    const state = createStreamState();
    expect(state.turnTerminated).toBe(false);
  });
});

describe("turn-terminator declaration", () => {
  it("end_turn is declared with endsTurn: true", () => {
    const endTurn = messagingTools.find((t) => t.name === "end_turn");
    expect(endTurn?.endsTurn).toBe(true);
  });

  it("send is NOT declared as a turn terminator", () => {
    // `send` is for mid-turn rich content (photos, polls, scheduled messages,
    // etc.) — calling it does NOT mean the model is done. Only end_turn
    // declares the turn finished.
    const send = messagingTools.find((t) => t.name === "send");
    expect(send?.endsTurn).toBeFalsy();
  });

  it("isTurnTerminator returns true for end_turn", () => {
    expect(isTurnTerminator("end_turn")).toBe(true);
  });

  it("isTurnTerminator returns false for non-terminator tools", () => {
    expect(isTurnTerminator("send")).toBe(false);
    expect(isTurnTerminator("react")).toBe(false);
    expect(isTurnTerminator("fetch_url")).toBe(false);
    expect(isTurnTerminator("nonexistent_tool")).toBe(false);
  });

  it("only one turn terminator currently exists (end_turn)", () => {
    // If a future change adds a second terminator, this test should fail
    // and the author should document why a new terminator is necessary.
    const terminators = ALL_TOOLS.filter((t) => t.endsTurn).map((t) => t.name);
    expect(terminators).toEqual(["end_turn"]);
  });
});

describe("end_turn tool definition", () => {
  const endTurn = messagingTools.find((t) => t.name === "end_turn");

  it("is registered in messagingTools", () => {
    expect(endTurn).toBeDefined();
    expect(endTurn?.tag).toBe("messaging");
    expect(endTurn?.frontends).toEqual(["telegram", "teams"]);
  });

  it("has text, reply_to, and buttons schema fields", () => {
    expect(endTurn?.schema).toBeDefined();
    expect(endTurn?.schema.text).toBeDefined();
    expect(endTurn?.schema.reply_to).toBeDefined();
    expect(endTurn?.schema.buttons).toBeDefined();
  });

  it("dispatches plain text via send_message bridge", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await endTurn!.execute({ text: "Hello sur" }, bridge);
    expect(bridge).toHaveBeenCalledWith("send_message", {
      text: "Hello sur",
      reply_to_message_id: undefined,
    });
  });

  it("dispatches text + reply_to via send_message bridge", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    await endTurn!.execute({ text: "Yep", reply_to: 12345 }, bridge);
    expect(bridge).toHaveBeenCalledWith("send_message", {
      text: "Yep",
      reply_to_message_id: 12345,
    });
  });

  it("dispatches text + buttons via send_message_with_buttons bridge", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const buttons = [[{ text: "Click", callback_data: "x" }]];
    await endTurn!.execute({ text: "Pick", buttons }, bridge);
    expect(bridge).toHaveBeenCalledWith("send_message_with_buttons", {
      text: "Pick",
      rows: buttons,
      reply_to_message_id: undefined,
    });
  });

  it("ends silently with no bridge call when text is omitted", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const result = await endTurn!.execute({}, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, silent: true });
  });

  it("ends silently with no bridge call when text is whitespace-only", async () => {
    const bridge = vi.fn(async () => ({ ok: true }));
    const result = await endTurn!.execute({ text: "   \n\t  " }, bridge);
    expect(bridge).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, silent: true });
  });
});
