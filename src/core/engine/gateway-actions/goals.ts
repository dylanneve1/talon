/**
 * Goals — persistent multi-turn objectives the background heartbeat pursues.
 * add / list / update / delete.
 */

import {
  addGoal,
  countOpenGoalsForChat,
  deleteGoal,
  formatGoal,
  generateGoalId,
  getGoal,
  getGoalsForChat,
  isGoalPriority,
  isGoalStatus,
  updateGoal,
  validateDescription,
  validateProgressNote,
  validateTitle,
  GOAL_STATUSES,
  MAX_OPEN_GOALS_PER_CHAT,
  OPEN_GOAL_STATUSES,
  type Goal,
  type GoalStatus,
} from "../../../storage/goal-store.js";
import { log } from "../../../util/log.js";
import { parseDueDate } from "./shared.js";
import type { SharedActionHandlers } from "./types.js";

export const goalHandlers: SharedActionHandlers = {
  add_goal: (body, chatId) => {
    const title = String(body.title ?? "").trim();
    const description = body.description ? String(body.description) : undefined;
    const priority = body.priority ?? "normal";

    const titleErr = validateTitle(title);
    if (titleErr) return { ok: false, error: titleErr };
    const descErr = validateDescription(description);
    if (descErr) return { ok: false, error: descErr };
    if (!isGoalPriority(priority))
      return { ok: false, error: "Priority must be low, normal, or high" };

    let dueAt: number | undefined;
    if (body.due !== undefined && body.due !== "") {
      dueAt = parseDueDate(body.due);
      if (dueAt === undefined)
        return {
          ok: false,
          error: `Invalid due date "${body.due}" — use ISO 8601 (e.g. 2026-06-20)`,
        };
    }

    const chatIdStr = String(chatId);
    const openCount = countOpenGoalsForChat(chatIdStr);
    if (openCount >= MAX_OPEN_GOALS_PER_CHAT) {
      return {
        ok: false,
        error: `Per-chat open-goal cap reached (${MAX_OPEN_GOALS_PER_CHAT}). Complete or abandon one before adding another.`,
      };
    }

    const now = Date.now();
    const goal: Goal = {
      id: generateGoalId(),
      chatId: chatIdStr,
      title,
      description,
      status: "active",
      priority,
      createdAt: now,
      updatedAt: now,
      dueAt,
    };
    addGoal(goal);
    log("gateway", `add_goal: "${title}" [${goal.id}]`);
    return {
      ok: true,
      text:
        `Created goal "${title}" (id: ${goal.id})\n` +
        `Priority: ${priority}${dueAt ? `\nDue: ${new Date(dueAt).toISOString()}` : ""}\n` +
        `The background heartbeat agent will pursue this goal on its runs. Record progress with update_goal.`,
    };
  },

  list_goals: (body, chatId) => {
    const includeClosed = body.include_closed === true;
    const goals = getGoalsForChat(
      String(chatId),
      includeClosed ? GOAL_STATUSES : OPEN_GOAL_STATUSES,
    );
    if (goals.length === 0)
      return {
        ok: true,
        text: includeClosed
          ? "No goals in this chat."
          : "No open goals in this chat.",
      };
    return {
      ok: true,
      text: `Goals (${goals.length}):\n\n${goals.map((g) => formatGoal(g)).join("\n\n")}`,
    };
  },

  update_goal: (body, chatId) => {
    const goalId = String(body.goal_id ?? "");
    if (!goalId) return { ok: false, error: "Missing goal_id" };
    const goal = getGoal(goalId);
    if (!goal) return { ok: false, error: `Goal ${goalId} not found` };
    if (goal.chatId !== String(chatId))
      return { ok: false, error: "Goal belongs to a different chat" };

    const updates: Parameters<typeof updateGoal>[1] = {};
    if (body.progress_note !== undefined) {
      const note = String(body.progress_note);
      const noteErr = validateProgressNote(note);
      if (noteErr) return { ok: false, error: noteErr };
      updates.progressNote = note;
    }
    if (body.status !== undefined) {
      if (!isGoalStatus(body.status))
        return {
          ok: false,
          error: `Status must be one of: ${GOAL_STATUSES.join(", ")}`,
        };
      updates.status = body.status as GoalStatus;
    }
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      const titleErr = validateTitle(title);
      if (titleErr) return { ok: false, error: titleErr };
      updates.title = title;
    }
    if (body.description !== undefined) {
      const description = String(body.description);
      const descErr = validateDescription(description);
      if (descErr) return { ok: false, error: descErr };
      updates.description = description;
    }
    if (body.priority !== undefined) {
      if (!isGoalPriority(body.priority))
        return { ok: false, error: "Priority must be low, normal, or high" };
      updates.priority = body.priority;
    }
    if (body.due !== undefined) {
      if (body.due === "") {
        updates.dueAt = null;
      } else {
        const dueAt = parseDueDate(body.due);
        if (dueAt === undefined)
          return {
            ok: false,
            error: `Invalid due date "${body.due}" — use ISO 8601 (e.g. 2026-06-20)`,
          };
        updates.dueAt = dueAt;
      }
    }
    if (Object.keys(updates).length === 0)
      return { ok: false, error: "No fields to update" };

    const updated = updateGoal(goalId, updates);
    log("gateway", `update_goal: "${updated?.title ?? goalId}" [${goalId}]`);
    return {
      ok: true,
      text: `Updated goal "${updated?.title ?? goalId}".\n\n${updated ? formatGoal(updated) : ""}`,
    };
  },

  delete_goal: (body, chatId) => {
    const goalId = String(body.goal_id ?? "");
    if (!goalId) return { ok: false, error: "Missing goal_id" };
    const goal = getGoal(goalId);
    if (!goal) return { ok: false, error: `Goal ${goalId} not found` };
    if (goal.chatId !== String(chatId))
      return { ok: false, error: "Goal belongs to a different chat" };
    deleteGoal(goalId);
    return { ok: true, text: `Deleted goal "${goal.title}" (${goalId})` };
  },
};
