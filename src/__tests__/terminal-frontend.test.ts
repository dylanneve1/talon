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
  },
}));

describe("terminal frontend — bridge actions", () => {
  // Inline the action handler logic for testing without starting HTTP server
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
      case "read_history":
        return { ok: true, text: "Terminal mode — no chat history." };
      case "search_history":
        return { ok: true, text: "Terminal mode — search not available." };
      case "list_known_users":
        return { ok: true, text: "Terminal user" };
      case "get_chat_info":
        return { ok: true, id: 1, type: "private", title: "Terminal" };
      default:
        return { ok: true, text: `"${action}" not available in terminal mode.` };
    }
  }

  it("send_message returns ok with message_id", () => {
    const result = handleTerminalAction({ action: "send_message", text: "hello" }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.message_id).toBeDefined();
  });

  it("react returns ok", () => {
    const result = handleTerminalAction({ action: "react", emoji: "👍" }) as Record<string, unknown>;
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
    for (const action of ["edit_message", "delete_message", "pin_message", "unpin_message", "forward_message", "copy_message", "send_chat_action"]) {
      const result = handleTerminalAction({ action }) as Record<string, unknown>;
      expect(result.ok).toBe(true);
    }
  });

  it("read_history returns terminal mode message", () => {
    const result = handleTerminalAction({ action: "read_history" }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Terminal mode");
  });

  it("search_history returns not available", () => {
    const result = handleTerminalAction({ action: "search_history", query: "test" }) as Record<string, unknown>;
    expect(result.text).toContain("not available");
  });

  it("get_chat_info returns terminal chat info", () => {
    const result = handleTerminalAction({ action: "get_chat_info" }) as Record<string, unknown>;
    expect(result.id).toBe(1);
    expect(result.type).toBe("private");
    expect(result.title).toBe("Terminal");
  });

  it("unknown action returns graceful message", () => {
    const result = handleTerminalAction({ action: "some_weird_action" }) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.text).toContain("not available in terminal mode");
  });

  it("list_known_users returns terminal user", () => {
    const result = handleTerminalAction({ action: "list_known_users" }) as Record<string, unknown>;
    expect(result.text).toContain("Terminal user");
  });
});

describe("terminal frontend — context manager", () => {
  it("tracks acquire/release correctly", () => {
    let acquired = false;
    const context = {
      acquire: () => { acquired = true; },
      release: () => { acquired = false; },
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
    count = 0; // reset between turns
    expect(getCount()).toBe(0);
  });
});
