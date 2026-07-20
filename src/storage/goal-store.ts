/**
 * Persistent goal store — multi-turn objectives the agent commits to
 * and pursues across sessions.
 *
 * Goals are the agency primitive: a chat conversation (or the agent
 * itself) records "keep an eye on X" / "finish Y by Friday" here, and
 * the heartbeat agent reads the open set on every run to decide what
 * to make progress on. Each goal carries a rolling last-progress note
 * so a heartbeat can pick up where the previous one left off.
 *
 * SQLite-backed (see repositories/goals-repo.ts for the statements;
 * this module holds the domain API and validation — no SQL here).
 * Goals are low-frequency data: reads go straight to the database,
 * no in-memory cache.
 */

import { randomUUID } from "node:crypto";
import * as repo from "./repositories/goals-repo.js";

export type {
  Goal,
  GoalPriority,
  GoalStatus,
} from "./repositories/goals-repo.js";
import type {
  Goal,
  GoalPriority,
  GoalStatus,
} from "./repositories/goals-repo.js";

export const GOAL_STATUSES: readonly GoalStatus[] = [
  "active",
  "paused",
  "completed",
  "abandoned",
];
export const GOAL_PRIORITIES: readonly GoalPriority[] = [
  "low",
  "normal",
  "high",
];

/** Statuses that count as "open" — shown to the heartbeat and listings. */
export const OPEN_GOAL_STATUSES: readonly GoalStatus[] = ["active", "paused"];

export const MAX_OPEN_GOALS_PER_CHAT = 25;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_PROGRESS_NOTE_LENGTH = 1_000;

// ── Validation ──────────────────────────────────────────────────────────────

export function isGoalStatus(value: unknown): value is GoalStatus {
  return GOAL_STATUSES.includes(value as GoalStatus);
}

export function isGoalPriority(value: unknown): value is GoalPriority {
  return GOAL_PRIORITIES.includes(value as GoalPriority);
}

export function validateTitle(title: string): string | null {
  if (!title.trim()) return "Goal title must not be empty";
  if (title.length > MAX_TITLE_LENGTH)
    return `Goal title too long (max ${MAX_TITLE_LENGTH} chars)`;
  return null;
}

export function validateDescription(
  description: string | undefined,
): string | null {
  if (description && description.length > MAX_DESCRIPTION_LENGTH)
    return `Goal description too long (max ${MAX_DESCRIPTION_LENGTH} chars)`;
  return null;
}

export function validateProgressNote(note: string | undefined): string | null {
  if (note && note.length > MAX_PROGRESS_NOTE_LENGTH)
    return `Progress note too long (max ${MAX_PROGRESS_NOTE_LENGTH} chars)`;
  return null;
}

// ── ID generation ───────────────────────────────────────────────────────────

export function generateGoalId(): string {
  return `goal_${randomUUID()}`;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addGoal(goal: Goal): void {
  repo.upsert(goal);
}

export function getGoal(id: string): Goal | undefined {
  return repo.get(id);
}

/** All goals for one chat, optionally filtered by status. */
export function getGoalsForChat(
  chatId: string,
  statuses?: readonly GoalStatus[],
): Goal[] {
  return repo.listByChat(chatId, statuses);
}

/** Open (active + paused) goals across every chat — the heartbeat's view. */
export function getOpenGoals(): Goal[] {
  return repo.listByStatus(OPEN_GOAL_STATUSES);
}

export function countOpenGoalsForChat(chatId: string): number {
  return repo.countByChatAndStatus(chatId, OPEN_GOAL_STATUSES);
}

/**
 * Apply a partial update. `updatedAt` is always bumped; a progress
 * note also stamps `lastProgressAt`. `dueAt: null` clears the
 * deadline (undefined leaves it untouched). Returns the updated
 * goal, or undefined when the id doesn't exist.
 */
export function updateGoal(
  id: string,
  updates: Partial<
    Pick<Goal, "title" | "description" | "status" | "priority">
  > & { dueAt?: number | null; progressNote?: string },
): Goal | undefined {
  const existing = repo.get(id);
  if (!existing) return undefined;
  const now = Date.now();
  const next: Goal = {
    ...existing,
    ...(updates.title !== undefined ? { title: updates.title } : {}),
    ...(updates.description !== undefined
      ? { description: updates.description }
      : {}),
    ...(updates.status !== undefined ? { status: updates.status } : {}),
    ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
    ...(updates.dueAt !== undefined
      ? { dueAt: updates.dueAt ?? undefined }
      : {}),
    ...(updates.progressNote !== undefined
      ? { lastProgressNote: updates.progressNote, lastProgressAt: now }
      : {}),
    updatedAt: now,
  };
  repo.upsert(next);
  return next;
}

export function deleteGoal(id: string): boolean {
  return repo.remove(id);
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Render one goal as a compact multi-line block — shared by the
 * `list_goals` tool output and the heartbeat prompt section so both
 * surfaces describe goals identically.
 */
export function formatGoal(
  goal: Goal,
  opts?: { withChatId?: boolean },
): string {
  const lines = [
    `- ${goal.title} [${goal.status}${goal.priority !== "normal" ? `, ${goal.priority} priority` : ""}]`,
    `  ID: ${goal.id}${opts?.withChatId ? ` | Chat: ${goal.chatId}` : ""}`,
  ];
  if (goal.description) lines.push(`  Detail: ${goal.description}`);
  if (goal.dueAt) lines.push(`  Due: ${new Date(goal.dueAt).toISOString()}`);
  lines.push(
    goal.lastProgressNote
      ? `  Last progress (${goal.lastProgressAt ? new Date(goal.lastProgressAt).toISOString() : "unknown"}): ${goal.lastProgressNote}`
      : `  Last progress: none recorded yet (created ${new Date(goal.createdAt).toISOString()})`,
  );
  return lines.join("\n");
}
