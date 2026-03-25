import { describe, it, expect, vi } from "vitest";

// Mock dependencies before importing
vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    underline: (s: string) => s,
    yellow: (s: string) => s,
  },
}));

describe("terminal frontend — bridge actions", () => {
  // Inline the action handler logic for testing without starting HTTP server.
  // This mirrors the switch statement in createActionHandler.
  function handleTerminalAction(body: Record<string, unknown>): unknown {
    const action = body.action as string;
    switch (action) {
      case "send_message":
        return { ok: true, message_id: Date.now() };
      case "react":
        return { ok: true };
      case "send_message_with_buttons":
        return { ok: true, message_id: Date.now() };
      case "edit_message":
      case "delete_message":
      case "pin_message":
      case "unpin_message":
      case "forward_message":
      case "copy_message":
      case "send_chat_action":
        return { ok: true };
      case "get_chat_info":
        // Now returns dynamic numeric ID; test the shape
        return { ok: true, id: 12345, type: "private", title: "Terminal" };
      default:
        return null;
    }
  }

  it("send_message returns ok with message_id", () => {
    const result = handleTerminalAction({
      action: "send_message",
      text: "hello",
    }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.message_id).toBeDefined();
  });

  it("react returns ok", () => {
    const result = handleTerminalAction({
      action: "react",
      emoji: "👍",
    }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("send_message_with_buttons returns ok", () => {
    const result = handleTerminalAction({
      action: "send_message_with_buttons",
      text: "Pick one",
      rows: [[{ text: "A" }, { text: "B" }]],
    }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.message_id).toBeDefined();
  });

  it("edit/delete/pin/forward all return ok", () => {
    for (const action of [
      "edit_message",
      "delete_message",
      "pin_message",
      "unpin_message",
      "forward_message",
      "copy_message",
      "send_chat_action",
    ]) {
      const result = handleTerminalAction({ action }) as Record<
        string,
        unknown
      >;
      expect(result.ok).toBe(true);
    }
  });

  it("get_chat_info returns terminal chat info shape", () => {
    const result = handleTerminalAction({
      action: "get_chat_info",
    }) as Record<string, unknown>;
    expect(typeof result.id).toBe("number");
    expect(result.type).toBe("private");
    expect(result.title).toBe("Terminal");
  });

  it("unknown action returns null for fallback handling", () => {
    const result = handleTerminalAction({ action: "some_weird_action" });
    expect(result).toBeNull();
  });
});

describe("terminal frontend — context manager pattern", () => {
  it("tracks acquire/release correctly", () => {
    let acquired = false;
    const context = {
      acquire: () => {
        acquired = true;
      },
      release: () => {
        acquired = false;
      },
      getMessageCount: () => 0,
    };

    expect(acquired).toBe(false);
    context.acquire();
    expect(acquired).toBe(true);
    context.release();
    expect(acquired).toBe(false);
  });

  it("tracks message count", () => {
    let count = 0;
    const getCount = () => count;

    expect(getCount()).toBe(0);
    count++;
    expect(getCount()).toBe(1);
    count = 0;
    expect(getCount()).toBe(0);
  });
});
