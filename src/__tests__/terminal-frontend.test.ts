import { beforeEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "../core/gateway.js";
import { createTerminalActionHandler } from "../frontend/terminal/index.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../util/watchdog.js", () => ({
  recordError: vi.fn(),
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

function createRenderer() {
  return {
    stopSpinner: vi.fn(),
    renderAssistantMessage: vi.fn(),
    writeln: vi.fn(),
  };
}

describe("terminal frontend bridge action handler", () => {
  let gateway: Gateway;
  let renderer: ReturnType<typeof createRenderer>;
  let handler: ReturnType<typeof createTerminalActionHandler>;

  beforeEach(() => {
    gateway = new Gateway();
    gateway.setContext(123);
    renderer = createRenderer();
    handler = createTerminalActionHandler(gateway, renderer);
  });

  it("renders send_message through the real action handler and records one bridge message", async () => {
    const result = await handler(
      { action: "send_message", text: "hello" },
      123,
    );

    expect(result).toMatchObject({ ok: true, message_id: expect.any(Number) });
    expect(renderer.stopSpinner).toHaveBeenCalledOnce();
    expect(renderer.renderAssistantMessage).toHaveBeenCalledWith("hello");
    expect(gateway.getMessageCount(123)).toBe(1);
  });

  it("renders reactions and button rows without incrementing unrelated chat contexts", async () => {
    gateway.setContext(456);

    await handler({ action: "react", emoji: "✅" }, 123);
    await handler(
      {
        action: "send_message_with_buttons",
        text: "Pick",
        rows: [[{ text: "A" }, { text: "B" }]],
      },
      123,
    );

    expect(renderer.writeln).toHaveBeenCalledWith(
      expect.stringContaining("✅"),
    );
    expect(renderer.renderAssistantMessage).toHaveBeenCalledWith("Pick");
    expect(
      renderer.writeln.mock.calls.some(
        ([line]) => line.includes("[A]") && line.includes("[B]"),
      ),
    ).toBe(true);
    expect(gateway.getMessageCount(123)).toBe(2);
    expect(gateway.getMessageCount(456)).toBe(0);
  });

  it("returns the active chat info supplied by the gateway context", async () => {
    await expect(handler({ action: "get_chat_info" }, 123)).resolves.toEqual({
      ok: true,
      id: 123,
      type: "private",
      title: "Terminal",
    });
  });

  it("acknowledges no-op platform actions and lets unknown actions fall through", async () => {
    for (const action of [
      "edit_message",
      "delete_message",
      "pin_message",
      "unpin_message",
      "forward_message",
      "copy_message",
      "send_chat_action",
    ]) {
      await expect(handler({ action }, 123)).resolves.toEqual({ ok: true });
    }

    await expect(
      handler({ action: "some_weird_action" }, 123),
    ).resolves.toBeNull();
  });
});
