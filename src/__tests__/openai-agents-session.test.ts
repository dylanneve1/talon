/**
 * TalonSession — SDK-session wrapper with replay-time transforms +
 * bounded storage.
 *
 * Tests focus on the value-add behaviour, not on re-verifying the
 * SDK's own session contract:
 *
 *   - The transform pipeline is invoked in order and on every replay.
 *   - The default media-stripper removes image/file payloads from
 *     function_call_result outputs (single + array forms) and from
 *     assistant/user messages.
 *   - Plain text items are never modified.
 *   - Custom transforms can be plugged in and observed.
 *   - The capacity policy evicts oldest items and never orphans a
 *     function_call from its result.
 *   - `clearSession()` keeps the SDK's reset semantics intact.
 *   - `computeEvictionBoundary` is correct in isolation (unit-tested
 *     directly so the eviction invariant is provable without the SDK).
 */

import { describe, it, expect } from "vitest";
import {
  TalonSession,
  MediaStripperTransform,
  computeEvictionBoundary,
  type SessionItemTransform,
} from "../backend/openai-agents/session.js";
import type { AgentInputItem } from "@openai/agents";

// ── Fixtures ──────────────────────────────────────────────────────────────

function userMsg(text: string): AgentInputItem {
  return {
    role: "user",
    content: [{ type: "input_text", text }],
  } as AgentInputItem;
}

function userMsgWithImage(): AgentInputItem {
  return {
    role: "user",
    content: [
      { type: "input_text", text: "look" },
      { type: "input_image", image: "A".repeat(100) },
    ],
  } as AgentInputItem;
}

function imageResult(callId: string): AgentInputItem {
  return {
    type: "function_call_result",
    name: "browser_take_screenshot",
    callId,
    status: "completed",
    output: {
      type: "image",
      image: { data: "A".repeat(1000), mediaType: "image/png" },
    },
  } as unknown as AgentInputItem;
}

function textResult(callId: string, text: string): AgentInputItem {
  return {
    type: "function_call_result",
    name: "Bash",
    callId,
    status: "completed",
    output: text,
  } as unknown as AgentInputItem;
}

function functionCall(
  callId: string,
  name = "browser_take_screenshot",
): AgentInputItem {
  return {
    type: "function_call",
    name,
    callId,
    status: "completed",
    arguments: "{}",
  } as unknown as AgentInputItem;
}

// ── MediaStripperTransform ────────────────────────────────────────────────

describe("MediaStripperTransform", () => {
  const stripper = new MediaStripperTransform();

  it("returns plain text items unchanged (same reference)", () => {
    const item = userMsg("hello");
    expect(stripper.apply(item)).toBe(item);
  });

  it("strips a single image content block in function_call_result.output", () => {
    const item = imageResult("c1");
    const out = stripper.apply(item) as {
      output: { type: string; text: string };
    };
    expect(out).not.toBe(item);
    expect(out.output.type).toBe("text");
    expect(out.output.text).toContain("media omitted");
  });

  it("strips image content blocks inside an array output", () => {
    const item = {
      type: "function_call_result",
      name: "tool",
      callId: "x",
      status: "completed",
      output: [
        { type: "input_text", text: "details" },
        { type: "input_image", image: "A".repeat(500) },
      ],
    } as unknown as AgentInputItem;
    const out = stripper.apply(item) as {
      output: Array<{ type: string; text?: string }>;
    };
    expect(out.output).toHaveLength(2);
    expect(out.output[0]).toEqual({ type: "input_text", text: "details" });
    expect(out.output[1].type).toBe("text");
    expect(out.output[1].text).toContain("media omitted");
  });

  it("leaves text-only function_call_result intact", () => {
    const item = textResult("c1", "command output");
    expect(stripper.apply(item)).toBe(item);
  });

  it("strips embedded images in user messages", () => {
    const item = userMsgWithImage();
    const out = stripper.apply(item) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(out).not.toBe(item);
    expect(out.content[1].type).toBe("text");
    expect(out.content[1].text).toContain("media omitted");
  });
});

// ── Transform pipeline composition ────────────────────────────────────────

describe("TalonSession / transform pipeline", () => {
  it("applies transforms in registration order on every replay", () => {
    const log: string[] = [];
    const tagger = (tag: string): SessionItemTransform => ({
      name: `tag-${tag}`,
      apply: (item) => {
        log.push(tag);
        return item;
      },
    });
    const session = new TalonSession({
      transforms: [tagger("a"), tagger("b"), tagger("c")],
    });
    const item = userMsg("x");
    session.prepareHistoryItemForModelInput(item);
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("threads each transform's output into the next", () => {
    const rename: SessionItemTransform = {
      name: "rename",
      apply: (item) => {
        const msg = item as { role?: string; content?: unknown };
        if (msg.role === "user" && Array.isArray(msg.content)) {
          return {
            ...item,
            content: (
              msg.content as Array<{ type: string; text?: string }>
            ).map((b) =>
              b.type === "input_text"
                ? { ...b, text: (b.text ?? "").toUpperCase() }
                : b,
            ),
          } as AgentInputItem;
        }
        return item;
      },
    };
    const session = new TalonSession({ transforms: [rename] });
    const out = session.prepareHistoryItemForModelInput(userMsg("hello")) as {
      content: Array<{ text: string }>;
    };
    expect(out.content[0].text).toBe("HELLO");
  });

  it("default transforms include media stripping", async () => {
    const session = new TalonSession({ sessionId: "c1" });
    const item = imageResult("c1");
    await session.addItems([item]);
    const replayed = await session.getItems();
    // getItems returns the SDK-stored (cloned) item; transforms only apply
    // on replay. Verify that prepareHistoryItemForModelInput strips media.
    const out = session.prepareHistoryItemForModelInput(replayed[0]) as {
      output: { type: string; text?: string };
    };
    expect(out.output.type).toBe("text");
    expect(out.output.text).toContain("media omitted");
  });
});

// ── computeEvictionBoundary ───────────────────────────────────────────────

describe("computeEvictionBoundary", () => {
  it("returns 0 when items fit under the cap", () => {
    expect(computeEvictionBoundary([userMsg("a"), userMsg("b")], 10)).toBe(0);
  });

  it("returns the simple boundary when no pair is split", () => {
    const items = [userMsg("a"), userMsg("b"), userMsg("c"), userMsg("d")];
    expect(computeEvictionBoundary(items, 2)).toBe(2);
  });

  it("extends the boundary by one when it would split a call from its result", () => {
    const items = [
      userMsg("a"),
      functionCall("call-1"),
      textResult("call-1", "ok"),
      userMsg("b"),
    ];
    // Cap = 2 → naïve drop = 2, leaving [textResult, userMsg]; that
    // orphans the result. Boundary should extend to drop the result too.
    expect(computeEvictionBoundary(items, 2)).toBe(3);
  });

  it("does NOT extend when dropping a call and its matching result together", () => {
    const items = [
      functionCall("call-1"),
      textResult("call-1", "ok"),
      userMsg("b"),
      userMsg("c"),
    ];
    // Cap = 2 → drop 2 → drops both call + result → safe.
    expect(computeEvictionBoundary(items, 2)).toBe(2);
  });
});

// ── End-to-end cap behaviour ──────────────────────────────────────────────

describe("TalonSession / capacity", () => {
  it("evicts older items once cap is exceeded", async () => {
    const session = new TalonSession({ maxItems: 5 });
    for (let i = 0; i < 10; i++) {
      await session.addItems([userMsg(`m${i}`)]);
    }
    const items = await session.getItems();
    expect(items.length).toBeLessThanOrEqual(5);
    // Newest items preserved at the tail.
    const last = items[items.length - 1] as {
      content: Array<{ text: string }>;
    };
    expect(last.content[0].text).toBe("m9");
  });

  it("never orphans a function_call across the eviction line", async () => {
    const session = new TalonSession({ maxItems: 50 });
    for (let i = 0; i < 100; i++) {
      await session.addItems([
        functionCall(`call-${i}`),
        textResult(`call-${i}`, `out ${i}`),
      ]);
    }
    const items = await session.getItems();
    const callIds = new Set(
      items
        .filter((i) => (i as { type?: string }).type === "function_call")
        .map((c) => (c as { callId: string }).callId),
    );
    const resultIds = new Set(
      items
        .filter((i) => (i as { type?: string }).type === "function_call_result")
        .map((r) => (r as { callId: string }).callId),
    );
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────

describe("TalonSession / lifecycle", () => {
  it("clearSession empties the underlying store", async () => {
    const session = new TalonSession({});
    await session.addItems([userMsg("a"), userMsg("b")]);
    await session.clearSession();
    expect(await session.getItems()).toEqual([]);
  });
});
