/**
 * Goal gateway actions — validation, chat scoping, and response
 * shaping in handleSharedAction. The store itself is covered by
 * goal-store.test.ts; here it runs against the real (per-worker
 * throwaway) SQLite database so the action layer is exercised
 * end-to-end without mocks between it and the rows.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

import { handleSharedAction } from "../core/engine/gateway-actions/index.js";
import {
  addGoal,
  generateGoalId,
  getGoal,
  getGoalsForChat,
  MAX_OPEN_GOALS_PER_CHAT,
  type Goal,
} from "../storage/goal-store.js";
import type { ActionResult } from "../core/types.js";

let chatSeq = 9_000_000;
/** Unique numeric chat id per test — the worker-shared DB persists. */
function freshChatId(): number {
  return ++chatSeq;
}

function makeGoal(chatId: number, overrides: Partial<Goal> = {}): Goal {
  const now = Date.now();
  return {
    id: generateGoalId(),
    chatId: String(chatId),
    title: "Track the upstream fix",
    status: "active",
    priority: "normal",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function act(
  chatId: number,
  body: Record<string, unknown>,
): Promise<ActionResult> {
  const result = await handleSharedAction(body, chatId);
  expect(result).not.toBeNull();
  return result!;
}

describe("add_goal", () => {
  it("creates an active goal scoped to the chat", async () => {
    const chatId = freshChatId();
    const result = await act(chatId, {
      action: "add_goal",
      title: "Ship the importer",
      description: "blocked on upstream review",
      priority: "high",
      due: "2026-06-20",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Ship the importer");

    const [goal] = getGoalsForChat(String(chatId));
    expect(goal.status).toBe("active");
    expect(goal.priority).toBe("high");
    expect(goal.description).toBe("blocked on upstream review");
    expect(goal.dueAt).toBe(Date.parse("2026-06-20"));
  });

  it("rejects empty titles, bad priorities, and bad due dates", async () => {
    const chatId = freshChatId();
    expect((await act(chatId, { action: "add_goal", title: "  " })).ok).toBe(
      false,
    );
    expect(
      (
        await act(chatId, {
          action: "add_goal",
          title: "ok",
          priority: "urgent",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await act(chatId, {
          action: "add_goal",
          title: "ok",
          due: "not-a-date",
        })
      ).ok,
    ).toBe(false);
    expect(getGoalsForChat(String(chatId))).toHaveLength(0);
  });

  it("enforces the per-chat open-goal cap", async () => {
    const chatId = freshChatId();
    for (let i = 0; i < MAX_OPEN_GOALS_PER_CHAT; i++) {
      addGoal(makeGoal(chatId, { title: `goal ${i}` }));
    }
    const result = await act(chatId, { action: "add_goal", title: "one more" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cap");
  });
});

describe("list_goals", () => {
  it("lists open goals by default and closed ones on request", async () => {
    const chatId = freshChatId();
    addGoal(makeGoal(chatId, { title: "open goal" }));
    addGoal(makeGoal(chatId, { title: "done goal", status: "completed" }));

    const open = await act(chatId, { action: "list_goals" });
    expect(open.text).toContain("open goal");
    expect(open.text).not.toContain("done goal");

    const all = await act(chatId, {
      action: "list_goals",
      include_closed: true,
    });
    expect(all.text).toContain("open goal");
    expect(all.text).toContain("done goal");
  });

  it("reports an empty chat", async () => {
    const result = await act(freshChatId(), { action: "list_goals" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("No open goals");
  });
});

describe("update_goal", () => {
  it("records progress and status changes", async () => {
    const chatId = freshChatId();
    const goal = makeGoal(chatId);
    addGoal(goal);

    const result = await act(chatId, {
      action: "update_goal",
      goal_id: goal.id,
      progress_note: "upstream merged; waiting on release",
      status: "paused",
    });
    expect(result.ok).toBe(true);

    const updated = getGoal(goal.id);
    expect(updated?.status).toBe("paused");
    expect(updated?.lastProgressNote).toBe(
      "upstream merged; waiting on release",
    );
    expect(updated?.lastProgressAt).toBeGreaterThan(0);
  });

  it("clears the due date on an empty string", async () => {
    const chatId = freshChatId();
    const goal = makeGoal(chatId, { dueAt: Date.parse("2026-07-01") });
    addGoal(goal);
    await act(chatId, { action: "update_goal", goal_id: goal.id, due: "" });
    expect(getGoal(goal.id)?.dueAt).toBeUndefined();
  });

  it("rejects unknown ids, foreign chats, bad statuses, and no-op updates", async () => {
    const chatId = freshChatId();
    const goal = makeGoal(chatId);
    addGoal(goal);

    expect(
      (await act(chatId, { action: "update_goal", goal_id: "goal_x" })).ok,
    ).toBe(false);
    const foreign = await act(freshChatId(), {
      action: "update_goal",
      goal_id: goal.id,
      status: "completed",
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toContain("different chat");
    expect(
      (
        await act(chatId, {
          action: "update_goal",
          goal_id: goal.id,
          status: "done",
        })
      ).ok,
    ).toBe(false);
    expect(
      (await act(chatId, { action: "update_goal", goal_id: goal.id })).ok,
    ).toBe(false);
  });
});

describe("delete_goal", () => {
  it("deletes own-chat goals and refuses foreign ones", async () => {
    const chatId = freshChatId();
    const goal = makeGoal(chatId);
    addGoal(goal);

    const foreign = await act(freshChatId(), {
      action: "delete_goal",
      goal_id: goal.id,
    });
    expect(foreign.ok).toBe(false);
    expect(getGoal(goal.id)).toBeDefined();

    const result = await act(chatId, {
      action: "delete_goal",
      goal_id: goal.id,
    });
    expect(result.ok).toBe(true);
    expect(getGoal(goal.id)).toBeUndefined();
  });
});
