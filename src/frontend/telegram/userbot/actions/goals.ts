/**
 * Goal tracking actions: create, list, update, complete, and manage goals.
 */

import {
  createGoal,
  updateGoal,
  completeGoal,
  abandonGoal,
  completeStep,
  getActiveGoals,
  getGoalById,
  getGoalsByStatus,
  searchGoals,
  type Goal,
} from "../../../../storage/goals.js";
import type { ActionRegistry } from "./index.js";

function formatGoal(g: Goal): string {
  const steps = g.steps.length > 0
    ? `\n    Steps: ${g.steps.map((s, i) => `${i}. [${s.done ? "x" : " "}] ${s.text}`).join(", ")}`
    : "";
  return `[${g.priority}] ${g.title} — ${g.status} (${g.progress}%)${steps}`;
}

export function registerGoalActions(registry: ActionRegistry) {
  registry.set("create_goal", async (body) => {
    const title = String(body.title ?? "");
    const description = String(body.description ?? "");
    if (!title) return { ok: false, error: "title is required" };

    const priority = (body.priority as "high" | "medium" | "low") ?? "medium";
    const steps = (body.steps as string[]) ?? [];
    const tags = (body.tags as string[]) ?? [];

    const goal = createGoal(title, description, priority, steps, tags);
    return { ok: true, goal };
  });

  registry.set("list_goals", async (body) => {
    const status = String(body.status ?? "active") as Goal["status"] | "all";
    const goals = status === "active" ? getActiveGoals() : getGoalsByStatus(status);
    if (goals.length === 0) return { ok: true, text: `No ${status} goals.`, goals: [] };
    const formatted = goals.map((g) => `[${g.id.slice(0, 8)}] ${formatGoal(g)}`);
    return { ok: true, text: formatted.join("\n"), count: goals.length };
  });

  registry.set("get_goal", async (body) => {
    const id = String(body.id ?? "");
    if (!id) return { ok: false, error: "id is required" };
    const goal = getGoalById(id);
    if (!goal) return { ok: false, error: `Goal not found: ${id}` };
    return { ok: true, goal };
  });

  registry.set("update_goal", async (body) => {
    const id = String(body.id ?? "");
    if (!id) return { ok: false, error: "id is required" };

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = String(body.title);
    if (body.description !== undefined) updates.description = String(body.description);
    if (body.priority !== undefined) updates.priority = String(body.priority);
    if (body.progress !== undefined) updates.progress = Number(body.progress);
    if (body.status !== undefined) updates.status = String(body.status);
    if (body.tags !== undefined) updates.tags = body.tags;

    const goal = updateGoal(id, updates);
    if (!goal) return { ok: false, error: `Goal not found: ${id}` };
    return { ok: true, goal };
  });

  registry.set("complete_goal", async (body) => {
    const id = String(body.id ?? "");
    if (!id) return { ok: false, error: "id is required" };
    const goal = completeGoal(id);
    if (!goal) return { ok: false, error: `Goal not found: ${id}` };
    return { ok: true, goal };
  });

  registry.set("complete_goal_step", async (body) => {
    const goalId = String(body.goal_id ?? "");
    const stepIndex = Number(body.step_index ?? -1);
    if (!goalId) return { ok: false, error: "goal_id is required" };
    if (stepIndex < 0) return { ok: false, error: "step_index is required (0-based)" };

    const goal = completeStep(goalId, stepIndex);
    if (!goal) return { ok: false, error: `Goal not found or invalid step index` };
    return { ok: true, goal };
  });

  registry.set("abandon_goal", async (body) => {
    const id = String(body.id ?? "");
    if (!id) return { ok: false, error: "id is required" };
    const goal = abandonGoal(id);
    if (!goal) return { ok: false, error: `Goal not found: ${id}` };
    return { ok: true, goal };
  });

  registry.set("search_goals", async (body) => {
    const query = String(body.query ?? "");
    if (!query) return { ok: false, error: "query is required" };
    const goals = searchGoals(query);
    if (goals.length === 0) return { ok: true, text: `No goals matching "${query}".`, goals: [] };
    const formatted = goals.map((g) => `[${g.id.slice(0, 8)}] ${formatGoal(g)}`);
    return { ok: true, text: formatted.join("\n"), count: goals.length };
  });
}
