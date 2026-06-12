/**
 * Goal store — CRUD, validation, and update semantics against the
 * real (per-worker throwaway) SQLite database. Durability/migration
 * plumbing is covered by the storage suites; this exercises the
 * domain layer.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  addGoal,
  countOpenGoalsForChat,
  deleteGoal,
  formatGoal,
  generateGoalId,
  getGoal,
  getGoalsForChat,
  getOpenGoals,
  isGoalPriority,
  isGoalStatus,
  updateGoal,
  validateDescription,
  validateProgressNote,
  validateTitle,
  MAX_DESCRIPTION_LENGTH,
  MAX_PROGRESS_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  type Goal,
} from "../storage/goal-store.js";

let chatSeq = 0;
/** Unique chat id per test — the worker-shared DB persists across tests. */
function freshChatId(): string {
  return `goal-test-chat-${++chatSeq}-${Date.now()}`;
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = Date.now();
  return {
    id: generateGoalId(),
    chatId: "goal-test-default",
    title: "Ship the release",
    status: "active",
    priority: "normal",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("goal-store CRUD", () => {
  let chatId: string;
  beforeEach(() => {
    chatId = freshChatId();
  });

  it("round-trips a goal with all fields", () => {
    const goal = makeGoal({
      chatId,
      description: "v2.0 with the new importer",
      priority: "high",
      dueAt: Date.parse("2026-06-20"),
      lastProgressNote: "CI is green",
      lastProgressAt: Date.now(),
    });
    addGoal(goal);
    expect(getGoal(goal.id)).toEqual(goal);
  });

  it("round-trips a goal with optional fields absent", () => {
    const goal = makeGoal({ chatId });
    addGoal(goal);
    const loaded = getGoal(goal.id);
    expect(loaded).toEqual(goal);
    expect(loaded?.description).toBeUndefined();
    expect(loaded?.dueAt).toBeUndefined();
    expect(loaded?.lastProgressNote).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(getGoal("goal_nope")).toBeUndefined();
  });

  it("lists goals per chat with status filtering", () => {
    const active = makeGoal({ chatId });
    const done = makeGoal({ chatId, status: "completed" });
    addGoal(active);
    addGoal(done);

    const open = getGoalsForChat(chatId, ["active", "paused"]);
    expect(open.map((g) => g.id)).toEqual([active.id]);

    const all = getGoalsForChat(chatId);
    expect(all.map((g) => g.id).sort()).toEqual([active.id, done.id].sort());
  });

  it("getOpenGoals spans chats and excludes closed goals", () => {
    const otherChat = freshChatId();
    const a = makeGoal({ chatId });
    const b = makeGoal({ chatId: otherChat, status: "paused" });
    const closed = makeGoal({ chatId, status: "abandoned" });
    addGoal(a);
    addGoal(b);
    addGoal(closed);

    const openIds = getOpenGoals().map((g) => g.id);
    expect(openIds).toContain(a.id);
    expect(openIds).toContain(b.id);
    expect(openIds).not.toContain(closed.id);
  });

  it("counts open goals per chat", () => {
    addGoal(makeGoal({ chatId }));
    addGoal(makeGoal({ chatId, status: "paused" }));
    addGoal(makeGoal({ chatId, status: "completed" }));
    expect(countOpenGoalsForChat(chatId)).toBe(2);
  });

  it("deletes goals and reports whether one existed", () => {
    const goal = makeGoal({ chatId });
    addGoal(goal);
    expect(deleteGoal(goal.id)).toBe(true);
    expect(getGoal(goal.id)).toBeUndefined();
    expect(deleteGoal(goal.id)).toBe(false);
  });
});

describe("updateGoal semantics", () => {
  it("bumps updatedAt and applies field updates", () => {
    const goal = makeGoal({
      chatId: freshChatId(),
      updatedAt: Date.now() - 60_000,
    });
    addGoal(goal);
    const updated = updateGoal(goal.id, {
      title: "Ship the release (v2)",
      status: "paused",
      priority: "high",
    });
    expect(updated?.title).toBe("Ship the release (v2)");
    expect(updated?.status).toBe("paused");
    expect(updated?.priority).toBe("high");
    expect(updated!.updatedAt).toBeGreaterThan(goal.updatedAt);
  });

  it("stamps lastProgressAt when a progress note is recorded", () => {
    const goal = makeGoal({ chatId: freshChatId() });
    addGoal(goal);
    const before = Date.now();
    const updated = updateGoal(goal.id, { progressNote: "drafted the plan" });
    expect(updated?.lastProgressNote).toBe("drafted the plan");
    expect(updated?.lastProgressAt).toBeGreaterThanOrEqual(before);
  });

  it("leaves untouched fields alone and clears dueAt only on null", () => {
    const dueAt = Date.parse("2026-07-01");
    const goal = makeGoal({ chatId: freshChatId(), dueAt });
    addGoal(goal);

    const noTouch = updateGoal(goal.id, { progressNote: "checked in" });
    expect(noTouch?.dueAt).toBe(dueAt);
    expect(noTouch?.title).toBe(goal.title);

    const cleared = updateGoal(goal.id, { dueAt: null });
    expect(cleared?.dueAt).toBeUndefined();
  });

  it("returns undefined for unknown ids", () => {
    expect(updateGoal("goal_missing", { status: "completed" })).toBeUndefined();
  });
});

describe("validation helpers", () => {
  it("validates titles", () => {
    expect(validateTitle("Ship it")).toBeNull();
    expect(validateTitle("   ")).toMatch(/empty/);
    expect(validateTitle("x".repeat(MAX_TITLE_LENGTH + 1))).toMatch(/too long/);
  });

  it("validates descriptions and progress notes", () => {
    expect(validateDescription(undefined)).toBeNull();
    expect(validateDescription("fine")).toBeNull();
    expect(validateDescription("x".repeat(MAX_DESCRIPTION_LENGTH + 1))).toMatch(
      /too long/,
    );
    expect(validateProgressNote(undefined)).toBeNull();
    expect(
      validateProgressNote("x".repeat(MAX_PROGRESS_NOTE_LENGTH + 1)),
    ).toMatch(/too long/);
  });

  it("recognises statuses and priorities", () => {
    expect(isGoalStatus("active")).toBe(true);
    expect(isGoalStatus("done")).toBe(false);
    expect(isGoalPriority("high")).toBe(true);
    expect(isGoalPriority("urgent")).toBe(false);
  });
});

describe("formatGoal", () => {
  it("renders title, id, and progress; chat id only when asked", () => {
    const goal = makeGoal({
      chatId: "12345",
      priority: "high",
      description: "the details",
      lastProgressNote: "halfway there",
      lastProgressAt: Date.now(),
    });
    const plain = formatGoal(goal);
    expect(plain).toContain(goal.title);
    expect(plain).toContain(goal.id);
    expect(plain).toContain("high priority");
    expect(plain).toContain("halfway there");
    expect(plain).not.toContain("Chat: 12345");

    expect(formatGoal(goal, { withChatId: true })).toContain("Chat: 12345");
  });

  it("notes when no progress has been recorded", () => {
    expect(formatGoal(makeGoal())).toContain("none recorded yet");
  });
});
