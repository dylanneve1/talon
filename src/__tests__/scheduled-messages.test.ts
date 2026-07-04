/**
 * Persistent scheduled messages — the store (storage/scheduled-store)
 * and the Telegram schedule/cancel/list/restore handlers.
 *
 * The behaviour pinned here is the whole point of the feature: a
 * scheduled send survives a restart. Before this, `send(...,
 * delay_seconds=N)` lived only in an in-process setTimeout — the model
 * promises "reminder in 30 minutes", Talon restarts, and the promise
 * silently evaporates.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const envBackup = process.env.TALON_DB_PATH;
let tempHome: string;
let closeDb: (() => void) | null = null;

async function freshImports() {
  // Re-import per test so module-scoped DB handles pick up the
  // per-test TALON_DB_PATH.
  vi.resetModules();
  const db = await import("../storage/db.js");
  closeDb = db.closeDatabase;
  const store = await import("../storage/scheduled-store.js");
  const telegram = await import("../frontend/telegram/actions/messaging.js");
  return { store, telegram };
}

/** Minimal fake grammY bot capturing sendMessage calls. */
function fakeBot() {
  const sent: Array<{ chatId: number; text: string; opts?: unknown }> = [];
  return {
    sent,
    api: {
      sendMessage: vi.fn(
        async (chatId: number, text: string, opts?: unknown) => {
          sent.push({ chatId, text, opts });
          return { message_id: sent.length };
        },
      ),
    },
  };
}

type Ctx = {
  bot: ReturnType<typeof fakeBot>;
  scheduledMessages: Map<string, ReturnType<typeof setTimeout>>;
};
function fakeCtx(): Ctx {
  return { bot: fakeBot(), scheduledMessages: new Map() };
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "talon-sched-"));
  process.env.TALON_DB_PATH = join(tempHome, "talon.db");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  closeDb?.();
  closeDb = null;
  if (envBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = envBackup;
  rmSync(tempHome, { recursive: true, force: true });
});

describe("scheduled-store", () => {
  it("saves, lists (soonest first, per frontend/chat), and deletes", async () => {
    const { store } = await freshImports();
    const base = {
      frontend: "telegram",
      text: "hi",
      createdAt: Date.now(),
    };
    store.saveScheduled({ ...base, id: "b", chatId: "1", fireAt: 2000 });
    store.saveScheduled({ ...base, id: "a", chatId: "1", fireAt: 1000 });
    store.saveScheduled({ ...base, id: "c", chatId: "2", fireAt: 500 });
    store.saveScheduled({
      ...base,
      id: "d",
      chatId: "1",
      fireAt: 100,
      frontend: "discord",
    });

    expect(store.listScheduled("telegram").map((e) => e.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(
      store.listScheduledForChat("telegram", "1").map((e) => e.id),
    ).toEqual(["a", "b"]);
    expect(store.deleteScheduled("a")).toBe(true);
    expect(store.deleteScheduled("a")).toBe(false);
    expect(
      store.listScheduledForChat("telegram", "1").map((e) => e.id),
    ).toEqual(["b"]);
  });
});

describe("telegram schedule_message", () => {
  it("persists the entry, fires it, and cleans up store + timer map", async () => {
    const { store, telegram } = await freshImports();
    const ctx = fakeCtx();

    const res = (await telegram.messagingHandlers.schedule_message(
      { text: "future ping", delay_seconds: 60 },
      42,
      ctx as never,
    )) as { ok: boolean; schedule_id: string };
    expect(res.ok).toBe(true);

    // Persisted and armed.
    expect(store.listScheduledForChat("telegram", "42")).toHaveLength(1);
    expect(ctx.scheduledMessages.size).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.bot.sent).toHaveLength(1);
    expect(ctx.bot.sent[0].text).toContain("future ping");
    // Fired → gone from both store and map.
    expect(store.listScheduledForChat("telegram", "42")).toHaveLength(0);
    expect(ctx.scheduledMessages.size).toBe(0);
  });

  it("cancel_scheduled clears both the timer and the persisted entry", async () => {
    const { store, telegram } = await freshImports();
    const ctx = fakeCtx();
    const res = (await telegram.messagingHandlers.schedule_message(
      { text: "never", delay_seconds: 60 },
      42,
      ctx as never,
    )) as unknown as { schedule_id: string };

    const cancel = await telegram.messagingHandlers.cancel_scheduled(
      { schedule_id: res.schedule_id },
      42,
      ctx as never,
    );
    expect(cancel).toMatchObject({ ok: true, cancelled: true });
    expect(store.listScheduled("telegram")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(ctx.bot.sent).toHaveLength(0);
  });

  it("cancel_scheduled works on a store-only entry (scheduled before a restart)", async () => {
    const { store, telegram } = await freshImports();
    store.saveScheduled({
      id: "sched_orphan",
      frontend: "telegram",
      chatId: "42",
      text: "pre-restart",
      fireAt: Date.now() + 60_000,
      createdAt: Date.now(),
    });
    const ctx = fakeCtx(); // fresh map — no live timer for the entry
    const cancel = await telegram.messagingHandlers.cancel_scheduled(
      { schedule_id: "sched_orphan" },
      42,
      ctx as never,
    );
    expect(cancel).toMatchObject({ ok: true, cancelled: true });
    expect(store.listScheduled("telegram")).toHaveLength(0);
  });

  it("list_scheduled reports pending sends for this chat only", async () => {
    const { telegram } = await freshImports();
    const ctx = fakeCtx();
    await telegram.messagingHandlers.schedule_message(
      { text: "mine", delay_seconds: 120 },
      42,
      ctx as never,
    );
    await telegram.messagingHandlers.schedule_message(
      { text: "other chat", delay_seconds: 120 },
      99,
      ctx as never,
    );
    const res = (await telegram.messagingHandlers.list_scheduled(
      {},
      42,
      ctx as never,
    )) as { ok: boolean; count: number; scheduled: Array<{ text: string }> };
    expect(res.count).toBe(1);
    expect(res.scheduled[0].text).toBe("mine");
  });
});

describe("restoreScheduledMessages (post-restart)", () => {
  it("re-arms future entries so they still fire", async () => {
    const { store, telegram } = await freshImports();
    store.saveScheduled({
      id: "sched_future",
      frontend: "telegram",
      chatId: "42",
      text: "survived the restart",
      fireAt: Date.now() + 30_000,
      createdAt: Date.now(),
    });

    const ctx = fakeCtx();
    telegram.restoreScheduledMessages(ctx.bot as never, ctx.scheduledMessages);
    expect(ctx.scheduledMessages.size).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ctx.bot.sent).toHaveLength(1);
    expect(ctx.bot.sent[0].text).toContain("survived the restart");
    expect(store.listScheduled("telegram")).toHaveLength(0);
  });

  it("fires overdue entries immediately (late beats never)", async () => {
    const { store, telegram } = await freshImports();
    store.saveScheduled({
      id: "sched_overdue",
      frontend: "telegram",
      chatId: "42",
      text: "sorry I'm late",
      fireAt: Date.now() - 5_000,
      createdAt: Date.now() - 65_000,
    });

    const ctx = fakeCtx();
    telegram.restoreScheduledMessages(ctx.bot as never, ctx.scheduledMessages);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.bot.sent).toHaveLength(1);
    expect(store.listScheduled("telegram")).toHaveLength(0);
  });

  it("drops entries stale past the overdue cap instead of spamming", async () => {
    const { store, telegram } = await freshImports();
    store.saveScheduled({
      id: "sched_ancient",
      frontend: "telegram",
      chatId: "42",
      text: "week-old reminder",
      fireAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
      createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });

    const ctx = fakeCtx();
    telegram.restoreScheduledMessages(ctx.bot as never, ctx.scheduledMessages);
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.bot.sent).toHaveLength(0);
    expect(store.listScheduled("telegram")).toHaveLength(0);
  });

  it("leaves other frontends' entries alone", async () => {
    const { store, telegram } = await freshImports();
    store.saveScheduled({
      id: "sched_discord",
      frontend: "discord",
      chatId: "42",
      text: "not yours",
      fireAt: Date.now() + 30_000,
      createdAt: Date.now(),
    });
    const ctx = fakeCtx();
    telegram.restoreScheduledMessages(ctx.bot as never, ctx.scheduledMessages);
    expect(ctx.scheduledMessages.size).toBe(0);
    expect(store.listScheduled("discord")).toHaveLength(1);
  });
});
