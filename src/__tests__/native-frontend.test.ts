/**
 * Unit tests for the `native` frontend's pure pieces — the bits that don't
 * need a live daemon or DB:
 *   - protocol mappers (previewOf, historyToClientMessage)
 *   - the in-memory chat registry (ensure/get/byNumeric/list ordering)
 *   - the gateway action handler (delivery tools → bridge events)
 *   - the settings snapshot + allowlist enforcement
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  previewOf,
  historyToClientMessage,
  BOT_SENDER_ID,
  USER_SENDER_ID,
} from "../frontend/native/protocol.js";
import { NativeChats, DEFAULT_CHAT_TITLE } from "../frontend/native/chats.js";
import { extractSessionName } from "../backend/shared/session-name.js";
import { createNativeActionHandler } from "../frontend/native/actions.js";
import {
  configSnapshot,
  applyConfigUpdate,
  EDITABLE,
} from "../frontend/native/settings.js";
import {
  removeBridgeDiscovery,
  writeBridgeDiscovery,
} from "../frontend/native/discovery.js";
import { summarizeToolResult } from "../frontend/native/index.js";
import { files } from "../util/paths.js";
import type { Gateway } from "../core/engine/gateway.js";
import type { TalonConfig } from "../util/config.js";

describe("native protocol mappers", () => {
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

describe("NativeChats registry", () => {
  it("creates, indexes by string + numeric id, and lists newest-first", () => {
    const chats = new NativeChats();
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
    const chats = new NativeChats();
    const first = chats.ensure("d_supplied");
    const again = chats.ensure("d_supplied");
    expect(first).toBe(again);
    expect(chats.count()).toBe(1);
  });

  it("auto-titles a placeholder chat from the first message, but never a renamed one", () => {
    // Mirrors maybeAutoTitle(): only rename while the chat still carries the
    // placeholder, and derive the title for free from the first message.
    const chats = new NativeChats();
    const fresh = chats.create();
    expect(fresh.title).toBe(DEFAULT_CHAT_TITLE);

    const autoTitle = (id: string, text: string) => {
      const entry = chats.get(id);
      if (!entry || (entry.title && entry.title !== DEFAULT_CHAT_TITLE)) return;
      const t = extractSessionName(text);
      if (t) chats.rename(id, t);
    };

    autoTitle(fresh.id, "[User] Improve the companion app UI [msg_id:42]");
    expect(chats.get(fresh.id)!.title).toBe("Improve the companion app UI");

    // A second message must not overwrite the now-named chat.
    autoTitle(fresh.id, "and also fix the padding");
    expect(chats.get(fresh.id)!.title).toBe("Improve the companion app UI");
  });

  it("leaves the placeholder when the first message has no usable text", () => {
    const chats = new NativeChats();
    const fresh = chats.create();
    const derived = extractSessionName("[User] [msg_id:7]");
    expect(derived).toBeUndefined();
    expect(fresh.title).toBe(DEFAULT_CHAT_TITLE);
  });
});

describe("native bridge discovery", () => {
  it("writes and removes the loopback discovery file", async () => {
    const original = files.nativeBridge;
    const dir = await mkdtemp(join(tmpdir(), "talon-native-discovery-"));
    const path = join(dir, "native-bridge.json");
    (files as { nativeBridge: string }).nativeBridge = path;
    try {
      await writeBridgeDiscovery({
        port: 19999,
        token: "secret",
        scheme: "http",
        startedAt: 123,
      });

      const raw = await readFile(path, "utf8");
      const json = JSON.parse(raw) as Record<string, unknown>;
      expect(json).toMatchObject({
        host: "127.0.0.1",
        port: 19999,
        token: "secret",
        scheme: "http",
        pid: process.pid,
        protocol: 1,
        startedAt: 123,
      });
      expect(typeof json.updatedAt).toBe("number");
      if (process.platform !== "win32") {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }

      await removeBridgeDiscovery();
      await expect(readFile(path, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      (files as { nativeBridge: string }).nativeBridge = original;
    }
  });
});

describe("native action handler", () => {
  function setup() {
    const chats = new NativeChats();
    const entry = chats.ensure("d_action");
    const incrementMessages = vi.fn();
    const gateway = { incrementMessages } as unknown as Gateway;
    const emitAssistant = vi.fn().mockReturnValue(4242);
    const emitPhoto = vi.fn().mockReturnValue(4343);
    const broadcast = vi.fn();
    const handler = createNativeActionHandler({
      chats,
      gateway,
      emitAssistant,
      emitPhoto,
      broadcast,
    });
    return {
      entry,
      handler,
      incrementMessages,
      emitAssistant,
      emitPhoto,
      broadcast,
    };
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

  it("delivers send_photo as a photo message with caption", async () => {
    const { entry, handler, incrementMessages, emitPhoto } = setup();
    const res = await handler(
      { action: "send_photo", file_path: "/tmp/x.png", caption: "look" },
      entry.numericId,
    );
    expect(emitPhoto).toHaveBeenCalledWith(entry, "/tmp/x.png", "look");
    expect(incrementMessages).toHaveBeenCalledWith(entry.numericId);
    expect(res).toMatchObject({ ok: true, message_id: 4343 });
  });

  it("rejects send_photo without a file_path", async () => {
    const { entry, handler, emitPhoto } = setup();
    const res = await handler({ action: "send_photo" }, entry.numericId);
    expect(emitPhoto).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false });
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

describe("native settings", () => {
  function fakeConfig(): TalonConfig {
    return {
      backend: "claude",
      frontend: "native",
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

describe("summarizeToolResult", () => {
  it("passes a plain string through, trimmed", () => {
    expect(summarizeToolResult("  hello  ")).toBe("hello");
  });

  it("extracts MCP text content parts", () => {
    const result = {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
        { type: "image", data: "…" },
      ],
    };
    expect(summarizeToolResult(result)).toBe("line one\nline two");
  });

  it("falls back to pretty JSON for other shapes", () => {
    const out = summarizeToolResult({ ok: true, count: 2 });
    expect(out).toContain('"ok": true');
    expect(out).toContain('"count": 2');
  });

  it("returns undefined for empty / nullish results", () => {
    expect(summarizeToolResult(null)).toBeUndefined();
    expect(summarizeToolResult(undefined)).toBeUndefined();
    expect(summarizeToolResult("   ")).toBeUndefined();
  });

  it("truncates very long output", () => {
    const out = summarizeToolResult("x".repeat(5000));
    expect(out!.length).toBeLessThan(5000);
    expect(out!.endsWith("… (truncated)")).toBe(true);
  });
});
