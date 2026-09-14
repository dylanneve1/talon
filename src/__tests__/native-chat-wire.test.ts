/**
 * The native frontend's per-chat wire projection + queued-follow-up
 * bookkeeping — the seam every `chat_updated` event is built from. Runs
 * over a real runtime object with a recording broadcast sink and the
 * per-worker SQLite store; no backend pool is bound, which is exactly the
 * early-boot state the projection has to tolerate.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { TalonConfig } from "../util/config.js";
import type { Gateway } from "../core/engine/gateway.js";
import {
  setChatBackend,
  setChatModelForBackend,
} from "../storage/chat-settings.js";
import {
  createNativeRuntime,
  type NativeRuntime,
} from "../frontend/native/runtime.js";
import { toClientChat } from "../frontend/native/chat-wire.js";
import { setQueued, takeQueued } from "../frontend/native/queue.js";
import type { BridgeEvent } from "../frontend/native/protocol.js";

function makeRuntime(): { runtime: NativeRuntime; events: BridgeEvent[] } {
  const events: BridgeEvent[] = [];
  const runtime = createNativeRuntime(
    { botDisplayName: "Talon" } as TalonConfig,
    {} as Gateway,
    (event) => events.push(event),
  );
  return { runtime, events };
}

describe("native chat wire projection", () => {
  let runtime: NativeRuntime;
  let events: BridgeEvent[];
  beforeEach(() => {
    ({ runtime, events } = makeRuntime());
  });

  it("projects the registry entry with settings, context and queue", () => {
    const entry = runtime.chats.create("Plans");
    setChatBackend(entry.id, "kilo");
    setChatModelForBackend(entry.id, "kilo", "kilo/fast");
    runtime.contextByChat.set(entry.id, {
      known: true,
      used: 10,
      max: 100,
      pct: 10,
      warn: false,
    });
    runtime.queuedByChat.set(entry.id, {
      text: "later",
      attachmentPath: "/tmp/x.png",
    });

    expect(toClientChat(runtime, entry)).toEqual({
      id: entry.id,
      title: "Plans",
      createdAt: entry.createdAt,
      lastActive: entry.lastActive,
      preview: "",
      model: "kilo/fast",
      backend: "kilo",
      effort: undefined,
      pulse: undefined,
      context: { known: true, used: 10, max: 100, pct: 10, warn: false },
      queued: { text: "later", hasAttachment: true },
    });
  });

  it("omits backend + model while the pool is not bound yet", () => {
    const entry = runtime.chats.create();
    const chat = toClientChat(runtime, entry);
    expect(chat.backend).toBeUndefined();
    expect(chat.model).toBeUndefined();
    expect(chat.queued).toBeUndefined();
    expect(chat.context).toBeUndefined();
  });

  it("setQueued trims, stores the attachment paths and syncs one chat_updated", () => {
    const entry = runtime.chats.create();
    setQueued(runtime, entry.id, {
      text: "  follow up  ",
      imagePath: "/media?id=m1",
      attachmentPath: "/uploads/1.png",
    });
    expect(runtime.queuedByChat.get(entry.id)).toEqual({
      text: "follow up",
      imagePath: "/media?id=m1",
      attachmentPath: "/uploads/1.png",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "chat_updated",
      chat: {
        id: entry.id,
        queued: { text: "follow up", hasAttachment: true },
      },
    });
  });

  it("setQueued with empty text clears the queue, and only broadcasts when something changed", () => {
    const entry = runtime.chats.create();
    setQueued(runtime, entry.id, { text: "   " });
    expect(events).toHaveLength(0);

    setQueued(runtime, entry.id, { text: "queued" });
    setQueued(runtime, entry.id, { text: "" });
    expect(runtime.queuedByChat.has(entry.id)).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["chat_updated", "chat_updated"]);
    expect(events[1]).toMatchObject({ chat: { queued: undefined } });
  });

  it("setQueued ignores chats the registry does not know", () => {
    setQueued(runtime, "d_missing", { text: "hello" });
    expect(runtime.queuedByChat.size).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("takeQueued hands back the entry, clears it and syncs the empty queue", () => {
    const entry = runtime.chats.create();
    expect(takeQueued(runtime, entry)).toBeUndefined();
    expect(events).toHaveLength(0);

    setQueued(runtime, entry.id, { text: "next", attachmentPath: "/a.png" });
    events.length = 0;
    expect(takeQueued(runtime, entry)).toEqual({
      text: "next",
      imagePath: undefined,
      attachmentPath: "/a.png",
    });
    expect(runtime.queuedByChat.has(entry.id)).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "chat_updated",
      chat: { id: entry.id, queued: undefined },
    });
  });
});
