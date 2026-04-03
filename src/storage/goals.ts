/**
 * Goal tracking system — persistent objectives with steps and progress.
 * Allows the bot to set, track, and complete goals over time.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { log, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type GoalStep = {
  text: string;
  done: boolean;
  completedAt?: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  status: "active" | "completed" | "paused" | "abandoned";
  priority: "high" | "medium" | "low";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  progress: number; // 0-100
  steps: GoalStep[];
  tags: string[];
  relatedChats?: string[];
  relatedUsers?: number[];
};

type GoalStore = {
  version: 1;
  goals: Goal[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_FILE = resolve(dirs.memory, "goals.json");

// ── State ────────────────────────────────────────────────────────────────────

let store: GoalStore = {
  version: 1,
  goals: [],
};

let dirty = false;

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadGoals(): void {
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as GoalStore;
      if (parsed.version === 1) {
        store = parsed;
        log("goals", `Loaded ${store.goals.length} goals`);
      }
    }
  } catch (err) {
    logError("goals", "Failed to load goals", err);
  }
}

export function flushGoals(): void {
  if (!dirty) return;
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    const data = JSON.stringify(store, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try {
        writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE));
      } catch {
        /* best effort */
      }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("goals", "Failed to flush goals", err);
  }
}

registerCleanup(() => flushGoals());

// ── Core functions ───────────────────────────────────────────────────────────

export function createGoal(
  title: string,
  description: string,
  priority: "high" | "medium" | "low" = "medium",
  steps: string[] = [],
  tags: string[] = [],
): Goal {
  const now = new Date().toISOString();
  const goal: Goal = {
    id: randomUUID(),
    title,
    description,
    status: "active",
    priority,
    createdAt: now,
    updatedAt: now,
    progress: 0,
    steps: steps.map((text) => ({ text, done: false })),
    tags,
  };
  store.goals.push(goal);
  dirty = true;
  flushGoals();
  log("goals", `Created goal: ${title} (${goal.id})`);
  return goal;
}

export function updateGoal(
  id: string,
  updates: Partial<Pick<Goal, "title" | "description" | "priority" | "progress" | "status" | "tags" | "relatedChats" | "relatedUsers">>,
): Goal | null {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) return null;

  if (updates.title !== undefined) goal.title = updates.title;
  if (updates.description !== undefined) goal.description = updates.description;
  if (updates.priority !== undefined) goal.priority = updates.priority;
  if (updates.progress !== undefined) goal.progress = Math.max(0, Math.min(100, updates.progress));
  if (updates.status !== undefined) goal.status = updates.status;
  if (updates.tags !== undefined) goal.tags = updates.tags;
  if (updates.relatedChats !== undefined) goal.relatedChats = updates.relatedChats;
  if (updates.relatedUsers !== undefined) goal.relatedUsers = updates.relatedUsers;
  goal.updatedAt = new Date().toISOString();

  dirty = true;
  flushGoals();
  return goal;
}

export function completeGoal(id: string): Goal | null {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) return null;

  goal.status = "completed";
  goal.progress = 100;
  goal.completedAt = new Date().toISOString();
  goal.updatedAt = goal.completedAt;

  // Mark all steps as done
  for (const step of goal.steps) {
    if (!step.done) {
      step.done = true;
      step.completedAt = goal.completedAt;
    }
  }

  dirty = true;
  flushGoals();
  log("goals", `Completed goal: ${goal.title} (${id})`);
  return goal;
}

export function abandonGoal(id: string): Goal | null {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) return null;

  goal.status = "abandoned";
  goal.updatedAt = new Date().toISOString();

  dirty = true;
  flushGoals();
  log("goals", `Abandoned goal: ${goal.title} (${id})`);
  return goal;
}

export function pauseGoal(id: string): Goal | null {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) return null;

  goal.status = "paused";
  goal.updatedAt = new Date().toISOString();

  dirty = true;
  flushGoals();
  log("goals", `Paused goal: ${goal.title} (${id})`);
  return goal;
}

export function completeStep(goalId: string, stepIndex: number): Goal | null {
  const goal = store.goals.find((g) => g.id === goalId);
  if (!goal) return null;
  if (stepIndex < 0 || stepIndex >= goal.steps.length) return null;

  goal.steps[stepIndex].done = true;
  goal.steps[stepIndex].completedAt = new Date().toISOString();
  goal.updatedAt = new Date().toISOString();

  // Auto-update progress based on step completion
  if (goal.steps.length > 0) {
    const doneCount = goal.steps.filter((s) => s.done).length;
    goal.progress = Math.round((doneCount / goal.steps.length) * 100);
  }

  dirty = true;
  flushGoals();
  return goal;
}

export function getActiveGoals(): Goal[] {
  return store.goals.filter((g) => g.status === "active");
}

export function getGoalById(id: string): Goal | null {
  return store.goals.find((g) => g.id === id) ?? null;
}

export function getGoalsByStatus(status: Goal["status"] | "all"): Goal[] {
  if (status === "all") return [...store.goals];
  return store.goals.filter((g) => g.status === status);
}

export function searchGoals(query: string): Goal[] {
  const lower = query.toLowerCase();
  return store.goals.filter(
    (g) =>
      g.title.toLowerCase().includes(lower) ||
      g.description.toLowerCase().includes(lower) ||
      g.tags.some((t) => t.toLowerCase().includes(lower)) ||
      g.steps.some((s) => s.text.toLowerCase().includes(lower)),
  );
}
