/**
 * Progress-text double-delivery on OpenCode / Kilo.
 *
 * The remote-server backends flush the pending text segment through
 * `onTextBlock` at every tool boundary, so the user sees "let me check…"
 * before the tool's typing indicator. But `closeCurrentSegment` also folds
 * that segment into `allResponseText`, and `finalizeResponseText` returns
 * the whole accumulation — so end-of-turn delivery shipped every narration
 * line a SECOND time, concatenated into one block.
 *
 * On a tool-heavy turn that is the "very spammy in opencode mode" symptom:
 * N progress messages, then one long message repeating all of them. Claude
 * and Codex never hit it because neither flushes mid-turn — `routeDelivery`
 * only ever deduped against *tool* deliveries (`deliveredTextNorms`), never
 * against progress sends.
 *
 * Contract: delivery ships only text the user has not already received, and
 * a flush that FAILED must still be delivered at end of turn (no data loss).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../storage/metrics.js", () => ({ incrementCounter: vi.fn() }));
vi.mock("../storage/sessions.js", () => ({ updateLiveTurn: vi.fn() }));

import {
  createStreamState,
  appendText,
  closeCurrentSegment,
  markProgressDelivered,
  finalizeResponseText,
  undeliveredResponseText,
} from "../backend/shared/stream-state.js";
import { routeDelivery } from "../backend/shared/delivery.js";

/** Simulate one tool boundary: flush the segment as a progress message. */
async function flushProgress(
  state: ReturnType<typeof createStreamState>,
  sent: string[],
  opts: { fail?: boolean } = {},
): Promise<void> {
  const progress = closeCurrentSegment(state);
  if (!progress) return;
  if (opts.fail) return; // send threw — do NOT mark delivered
  sent.push(progress);
  markProgressDelivered(state);
}

describe("progress text is not re-delivered at end of turn", () => {
  it("ships nothing extra when every segment already went out", async () => {
    const state = createStreamState("c1");
    const sent: string[] = [];

    // Three narration segments, each flushed at a tool boundary.
    appendText(state, "Let me check the logs.");
    await flushProgress(state, sent);
    appendText(state, "Now searching the repo.");
    await flushProgress(state, sent);
    appendText(state, "Found it.");
    await flushProgress(state, sent);

    const responseText = finalizeResponseText(state);
    const decision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c1",
      state,
      responseText,
      onTextBlock: async (t) => {
        sent.push(t);
      },
    });

    // Exactly the three progress messages — no concatenated repeat.
    expect(sent).toEqual([
      "Let me check the logs.",
      "Now searching the repo.",
      "Found it.",
    ]);
    expect(decision.route).toBe("progress");
    // The full transcript is still intact for history/trace.
    expect(responseText).toContain("Let me check the logs.");
    expect(responseText).toContain("Found it.");
  });

  it("ships only the trailing text written after the last flush", async () => {
    const state = createStreamState("c2");
    const sent: string[] = [];

    appendText(state, "Checking.");
    await flushProgress(state, sent);
    appendText(state, "Here is the final answer.");

    const responseText = finalizeResponseText(state);
    const decision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c2",
      state,
      responseText,
      onTextBlock: async (t) => {
        sent.push(t);
      },
    });

    expect(sent).toEqual(["Checking.", "Here is the final answer."]);
    expect(decision.route).toBe("text-part");
  });

  it("still delivers a segment whose progress send failed", async () => {
    const state = createStreamState("c3");
    const sent: string[] = [];

    // Mirrors production: a >4096-char flush that Telegram rejected.
    appendText(state, "A very long narration block.");
    await flushProgress(state, sent, { fail: true });
    appendText(state, " And the conclusion.");

    const responseText = finalizeResponseText(state);
    await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c3",
      state,
      responseText,
      onTextBlock: async (t) => {
        sent.push(t);
      },
    });

    // Nothing was lost: the failed segment rides along with the tail.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("A very long narration block.");
    expect(sent[0]).toContain("And the conclusion.");
  });

  it("leaves backends that never flush progress untouched", async () => {
    // Claude/Codex path: no mid-turn flush, so the whole reply ships once.
    const state = createStreamState("c4");
    const sent: string[] = [];
    appendText(state, "One-shot reply with no tool boundaries.");

    const responseText = finalizeResponseText(state);
    const decision = await routeDelivery({
      backendLabel: "Codex",
      chatId: "c4",
      state,
      responseText,
      onTextBlock: async (t) => {
        sent.push(t);
      },
    });

    expect(sent).toEqual(["One-shot reply with no tool boundaries."]);
    expect(decision.route).toBe("text-part");
    expect(undeliveredResponseText(state)).toBe(responseText);
  });

  it("a tool delivery still wins over pending text", async () => {
    const state = createStreamState("c5");
    const sent: string[] = [];
    appendText(state, "commentary after the tool call");
    state.hadBridgeDelivery = true;

    const responseText = finalizeResponseText(state);
    const decision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c5",
      state,
      responseText,
      onTextBlock: async (t) => {
        sent.push(t);
      },
    });

    expect(decision.route).toBe("tool");
    expect(sent).toEqual([]);
  });
});
