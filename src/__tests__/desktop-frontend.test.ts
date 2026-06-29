/**
 * Unit tests for the `desktop` frontend's pure pieces — the bits that don't
 * need a live daemon or DB:
 *   - protocol mappers (previewOf, historyToClientMessage)
 *   - the in-memory chat registry (ensure/get/byNumeric/list ordering)
 *   - the gateway action handler (delivery tools → bridge events)
 *   - the settings snapshot + allowlist enforcement
 */

import { describe, it, expect, vi } from "vitest";
import {
  previewOf,
  historyToClientMessage,
  BOT_SENDER_ID,
  USER_SENDER_ID,
} from "../frontend/desktop/protocol.js";
import { DesktopChats } from "../frontend/desktop/chats.js";
import { createDesktopActionHandler } from "../frontend/desktop/actions.js";
import {
  configSnapshot,
  applyConfigUpdate,
  EDITABLE,
} from "../frontend/desktop/settings.js";
import type { Gateway } from "../core/engine/gateway.js";
import type { TalonConfig } from "../util/config.js";

describe("desktop protocol mappers", () => {
  it("previewOf collapses whitespace and clips long text", () => {
    expect(previewOf("  hello   world \n there ")).toBe("hello world there");
    const long = "x".repeat(200);
    const out = previewOf(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });

  it("historyToClientMessage maps sender ids to roles", () => {
    const assistant = historyToClientMessage(
      {
        msgId: 5,
        senderId: BOT_SENDER_ID,
        senderName: "Talon",
        text: "hi",
        timestamp: 10,
      },
      "d_1",
    );
    expect(assistant).toMatchObject({
      id: "5",
      role: "assistant",
      text: "hi",
      ts: 10,
    });

    const user = historyToClientMessage(
      {
        msgId: 6,
        senderId: USER_SENDER_ID,
        senderName: "User",
        text: "yo",
        timestamp: 11,
      },
      "d_1",
    );
    expect(user.role).toBe("user");
  });
});

describe("DesktopChats registry", () => {
  it("creates, indexes by string + numeric id, and lists newest-first", () => {
    const chats = new DesktopChats();
    const a = chats.create();
    const b = chats.create();
    expect(chats.get(a.id)).toBe(a);
    expect(chats.byNumeric(a.numericId)).toBe(a);
    expect(chats.count()).toBe(2);

    // Touch `a` so it becomes most-recent; list() is newest-first.
    chats.touch(a.id, "latest message");
    const list = chats.list();
    expect(list[0].id).toBe(a.id);
    expect(list[0].preview).toBe("latest message");
    expect(list).toContain(b);
  });

  it("ensure() adopts a client-supplied id without duplicating", () => {
    const chats = new DesktopChats();
    const first = chats.ensure("d_supplied");
    const again = chats.ensure("d_supplied");
    expect(first).toBe(again);
    expect(chats.count()).toBe(1);
  });
});

describe("desktop action handler", () => {
  function setup() {
    const chats = new DesktopChats();
    const entry = chats.ensure("d_action");
    const incrementMessages = vi.fn();
    const gateway = { incrementMessages } as unknown as Gateway;
    const emitAssistant = vi.fn().mockReturnValue(4242);
    const broadcast = vi.fn();
    const handler = createDesktopActionHandler({
      chats,
      gateway,
      emitAssistant,
      broadcast,
    });
    return { entry, handler, incrementMessages, emitAssistant, broadcast };
  }

  it("delivers send_message as an assistant message and counts it", async () => {
    const { entry, handler, incrementMessages, emitAssistant } = setup();
    const res = await handler(
      { action: "send_message", text: "hello" },
      entry.numericId,
    );
    expect(emitAssistant).toHaveBeenCalledWith(entry, "hello");
    expect(incrementMessages).toHaveBeenCalledWith(entry.numericId);
    expect(res).toMatchObject({ ok: true, message_id: 4242 });
  });

  it("maps button rows on send_message_with_buttons", async () => {
    const { entry, handler, emitAssistant } = setup();
    await handler(
      {
        action: "send_message_with_buttons",
        text: "pick",
        rows: [[{ text: "Docs", url: "https://x" }]],
      },
      entry.numericId,
    );
    expect(emitAssistant).toHaveBeenCalledWith(entry, "pick", [
      [{ text: "Docs", url: "https://x", data: undefined }],
    ]);
  });

  it("broadcasts a reaction event", async () => {
    const { entry, handler, broadcast } = setup();
    const res = await handler(
      { action: "react", message_id: 7, emoji: "🔥" },
      entry.numericId,
    );
    expect(res).toMatchObject({ ok: true });
    expect(broadcast).toHaveBeenCalledWith({
      kind: "reaction",
      chatId: entry.id,
      messageId: "7",
      emoji: "🔥",
    });
  });

  it("answers get_chat_info and returns null for unknown actions", async () => {
    const { entry, handler } = setup();
    const info = await handler({ action: "get_chat_info" }, entry.numericId);
    expect(info).toMatchObject({
      ok: true,
      id: entry.numericId,
      type: "private",
    });

    const unknown = await handler(
      { action: "totally_made_up" },
      entry.numericId,
    );
    expect(unknown).toBeNull();
  });

  it("rejects actions for an unknown chat", async () => {
    const { handler } = setup();
    const res = await handler({ action: "send_message", text: "x" }, 999999);
    expect(res).toMatchObject({ ok: false });
  });
});

describe("desktop settings", () => {
  function fakeConfig(): TalonConfig {
    return {
      backend: "claude",
      frontend: "desktop",
      model: "default",
      botDisplayName: "Talon",
      timezone: "UTC",
      pulse: true,
      pulseIntervalMs: 300000,
      heartbeat: true,
      heartbeatIntervalMinutes: 60,
      dream: true,
    } as unknown as TalonConfig;
  }

  it("snapshot exposes the editable keys and curated fields", () => {
    const snap = configSnapshot(fakeConfig());
    expect(snap.backend).toBe("claude");
    expect(snap.botDisplayName).toBe("Talon");
    expect(snap.editable).toEqual([...EDITABLE]);
    expect(typeof snap.health.uptimeMs).toBe("number");
  });

  it("ignores non-editable keys (no mutation, no write)", () => {
    const config = fakeConfig();
    // `backend` is intentionally NOT editable through the bridge.
    const snap = applyConfigUpdate(config, { backend: "codex" });
    expect(config.backend).toBe("claude");
    expect(snap.backend).toBe("claude");
  });
});
