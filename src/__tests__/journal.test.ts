/**
 * Event journal — the bus's durable tail in talon.db.
 *
 * Uses a per-test TALON_DB_PATH temp database (same pattern as the
 * other SQLite store tests) with module reset, so the lazily-opened
 * db handle and the store's prune counter start fresh every time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishedEvent } from "../core/bus/index.js";

const dbEnvBackup = process.env.TALON_DB_PATH;
let tempDir: string;
let closeDb: (() => void) | null = null;

async function freshJournal() {
  vi.resetModules();
  const db = await import("../storage/db.js");
  closeDb = db.closeDatabase;
  return await import("../storage/journal.js");
}

function turnCompleted(chatId: string, id: number, at: number): PublishedEvent {
  return {
    type: "turn.completed",
    chatId,
    source: "message",
    durationMs: 5,
    inputTokens: 10,
    outputTokens: 3,
    id,
    at,
  };
}

function taskSettled(taskId: number, id: number, at: number): PublishedEvent {
  return {
    type: "task.settled",
    task: {
      id: taskId,
      kind: "turn",
      label: "message",
      state: "done",
      killable: true,
      queuedAt: at - 10,
      startedAt: at - 9,
      endedAt: at,
    },
    id,
    at,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "talon-journal-"));
  process.env.TALON_DB_PATH = join(tempDir, "talon.db");
});

afterEach(() => {
  closeDb?.();
  closeDb = null;
  if (dbEnvBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = dbEnvBackup;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("event journal", () => {
  it("round-trips events with durable, monotonic cursors", async () => {
    const journal = await freshJournal();

    journal.appendToJournal(turnCompleted("a", 1, 1_000));
    journal.appendToJournal(taskSettled(7, 2, 2_000));

    const entries = journal.readJournal();
    expect(entries).toHaveLength(2);
    // Newest first.
    expect(entries[0]).toMatchObject({
      at: 2_000,
      event: { type: "task.settled", task: { id: 7, state: "done" } },
    });
    expect(entries[1]).toMatchObject({
      at: 1_000,
      event: { type: "turn.completed", chatId: "a" },
    });
    expect(entries[0]!.seq).toBeGreaterThan(entries[1]!.seq);
    expect(journal.journalSize()).toBe(2);
  });

  it("filters by type and honours the limit", async () => {
    const journal = await freshJournal();
    for (let i = 1; i <= 5; i++) {
      journal.appendToJournal(turnCompleted(`chat-${i}`, i, i * 100));
      journal.appendToJournal(taskSettled(i, i + 10, i * 100 + 1));
    }

    const settled = journal.readJournal({ type: "task.settled", limit: 3 });
    expect(settled).toHaveLength(3);
    expect(settled.every((e) => e.event.type === "task.settled")).toBe(true);
    // Newest three of the five.
    expect(
      settled.map((e) =>
        e.event.type === "task.settled" ? e.event.task.id : -1,
      ),
    ).toEqual([5, 4, 3]);
  });

  it("survives a daemon restart — same db, fresh process state", async () => {
    let journal = await freshJournal();
    journal.appendToJournal(turnCompleted("persist", 1, 1_234));
    closeDb?.();

    journal = await freshJournal();
    const entries = journal.readJournal();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toMatchObject({
      type: "turn.completed",
      chatId: "persist",
    });
  });

  it("skips corrupt payload rows instead of failing the read", async () => {
    const journal = await freshJournal();
    journal.appendToJournal(turnCompleted("good", 1, 1_000));
    const repo = await import("../storage/repositories/journal-repo.js");
    repo.append(2_000, "task.settled", "{not json");

    const entries = journal.readJournal();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toMatchObject({ chatId: "good" });
  });

  it("prunes to the retention bound, keeping the newest rows", async () => {
    await freshJournal();
    const repo = await import("../storage/repositories/journal-repo.js");
    for (let i = 1; i <= 10; i++) {
      repo.append(
        i,
        "turn.completed",
        JSON.stringify({ type: "turn.completed", n: i }),
      );
    }

    repo.prune(4);

    const rows = repo.recent(100);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.at)).toEqual([10, 9, 8, 7]);
  });
});
