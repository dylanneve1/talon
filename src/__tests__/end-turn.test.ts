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
  processAssistantMessage,
} from "../backend/claude-sdk/stream.js";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { messagingTools } from "../core/tools/messaging.js";
import {
  isTurnTerminator,
  stripMcpPrefix,
  ALL_TOOLS,
} from "../core/tools/index.js";

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

  it("isTurnTerminator handles MCP-prefixed names", () => {
    // Tools served through MCP arrive with a `mcp__<server>__` prefix.
    // The check must normalize the prefix so the SDK's actual tool names
    // match the registry. Without this, downstream branches gated on
    // `state.turnTerminated` silently never fire — the flow-violation
    // re-prompt skip and trailing-prose dedup both break.
    expect(isTurnTerminator("mcp__telegram-tools__end_turn")).toBe(true);
    expect(isTurnTerminator("mcp__teams-tools__end_turn")).toBe(true);
    // Non-terminators with the same prefix shape still return false
    expect(isTurnTerminator("mcp__telegram-tools__send")).toBe(false);
    expect(isTurnTerminator("mcp__telegram-tools__react")).toBe(false);
    // Server name with hyphen + underscore must still match the boundary
    expect(isTurnTerminator("mcp__some-server-name__end_turn")).toBe(true);
  });

  it("stripMcpPrefix strips the mcp__<server>__ prefix when present", () => {
    expect(stripMcpPrefix("mcp__telegram-tools__end_turn")).toBe("end_turn");
    expect(stripMcpPrefix("mcp__brave-search__brave_web_search")).toBe(
      "brave_web_search",
    );
    // Non-greedy match takes the FIRST `__` after `mcp__` as the boundary
    expect(stripMcpPrefix("mcp__a__b__c")).toBe("b__c");
  });

  it("stripMcpPrefix returns input unchanged when no prefix matches", () => {
    expect(stripMcpPrefix("end_turn")).toBe("end_turn");
    expect(stripMcpPrefix("send")).toBe("send");
    expect(stripMcpPrefix("Read")).toBe("Read");
    // Looks like a prefix but missing the trailing `__`
    expect(stripMcpPrefix("mcp__incomplete")).toBe("mcp__incomplete");
    // Different prefix shape
    expect(stripMcpPrefix("not_mcp__server__tool")).toBe(
      "not_mcp__server__tool",
    );
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

// ── Production wire-shape contract ──────────────────────────────────────────
//
// These tests pin the integration between the SDK's actual emitted tool
// names (always MCP-prefixed when served via MCP) and the registry checks
// the handler runs against them. They are the tests that would have caught
// the bug fixed in this PR — strict-equality `isTurnTerminator("end_turn")`
// passed in unit tests but the production code path called
// `isTurnTerminator("mcp__telegram-tools__end_turn")` and silently failed.
//
// Auto-derived from ALL_TOOLS so adding a new endsTurn tool or a new MCP
// frontend stays covered without manually adding cases.

describe("turn-terminator integration with SDK production tool name shapes", () => {
  // Built-in MCP server names that the SDK is known to wire Talon's tools
  // through. Keep this list in sync with the actual MCP server registration
  // in src/core/tools/mcp-server.ts and frontend wiring.
  const KNOWN_MCP_SERVERS = ["telegram-tools", "teams-tools"];

  for (const tool of ALL_TOOLS.filter((t) => t.endsTurn)) {
    for (const server of KNOWN_MCP_SERVERS) {
      const sdkName = `mcp__${server}__${tool.name}`;

      it(`isTurnTerminator(${sdkName}) === true`, () => {
        // The SDK never emits bare names for MCP-served tools — it always
        // includes the `mcp__<server>__` prefix. Strict equality against the
        // registry's bare name was the production bug.
        expect(isTurnTerminator(sdkName)).toBe(true);
      });

      it(`processAssistantMessage + isTurnTerminator: ${sdkName} flips state.turnTerminated`, () => {
        // End-to-end check of the exact two-step the handler does:
        //   block.name -> tools[].name (via processAssistantMessage)
        //   tools[].name -> isTurnTerminator
        // If either step normalizes inconsistently, this breaks.
        const state = createStreamState();
        const msg = {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: sdkName,
                input: { text: "Hello sur" },
              },
            ],
          },
        } as unknown as SDKAssistantMessage;

        const result = processAssistantMessage(msg, state);
        expect(result.tools).toHaveLength(1);
        expect(result.tools[0].name).toBe(sdkName);

        // This is the exact line in handler.ts:
        //     if (isTurnTerminator(tool.name)) state.turnTerminated = true;
        if (isTurnTerminator(result.tools[0].name)) {
          state.turnTerminated = true;
        }
        expect(state.turnTerminated).toBe(true);
      });
    }
  }

  it("non-terminator tools stay non-terminator under MCP prefixing", () => {
    // Make sure prefix-stripping doesn't accidentally promote arbitrary
    // tools to terminators.
    const nonTerminators = ALL_TOOLS.filter((t) => !t.endsTurn);
    expect(nonTerminators.length).toBeGreaterThan(0);
    for (const tool of nonTerminators.slice(0, 5)) {
      for (const server of KNOWN_MCP_SERVERS) {
        expect(isTurnTerminator(`mcp__${server}__${tool.name}`)).toBe(false);
      }
    }
  });
});
