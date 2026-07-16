/**
 * `talon ps` / `talon kill` — the task table from the outside.
 *
 * Data comes from the running daemon's gateway (`GET /tasks`,
 * `POST /tasks/kill`); `--all` also folds in settled runs from the
 * durable journal in talon.db, which answers across restarts — with or
 * without a daemon. This module only renders — the table lives in
 * core/tasks/, the journal in storage/journal.ts.
 */

import pc from "picocolors";
import { findRunningInstance } from "../core/daemon/discovery.js";
import { fetchGateway, requireGatewayPort } from "./daemon-api.js";
import type {
  KillOutcome,
  TaskRecord,
  TaskState,
} from "../core/tasks/index.js";

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatTokens(task: TaskRecord): string {
  if (!task.usage) return "—";
  return `${formatTokenCount(task.usage.inputTokens)}→${formatTokenCount(task.usage.outputTokens)}`;
}

/** Queued: wait so far. Running: runtime so far. Settled: total runtime. */
function formatTime(task: TaskRecord, now: number): string {
  if (task.state === "queued") return formatDuration(now - task.queuedAt);
  const start = task.startedAt ?? task.queuedAt;
  return formatDuration((task.endedAt ?? now) - start);
}

function colorState(state: TaskState): string {
  switch (state) {
    case "running":
      return pc.green(state);
    case "queued":
      return pc.yellow(state);
    case "done":
      return pc.dim(state);
    case "failed":
      return pc.red(state);
    case "killed":
      return pc.magenta(state);
  }
}

/** Live tasks first (oldest running at the top), then history newest-first. */
function displayOrder(tasks: TaskRecord[]): TaskRecord[] {
  const live = tasks.filter(
    (t) => t.state === "running" || t.state === "queued",
  );
  const settled = tasks.filter(
    (t) => t.state !== "running" && t.state !== "queued",
  );
  live.sort((a, b) => a.id - b.id);
  // By time, not id: journal history spans daemon restarts, and per-process
  // ids restart with the daemon.
  settled.sort(
    (a, b) =>
      (b.endedAt ?? b.queuedAt) - (a.endedAt ?? a.queuedAt) || b.id - a.id,
  );
  return [...live, ...settled];
}

type Row = readonly string[];

const HEADER: Row = ["ID", "STATE", "KIND", "TIME", "TOKENS", "LABEL", "CHAT"];

function toRow(task: TaskRecord, now: number): Row {
  return [
    String(task.id),
    task.state,
    task.kind,
    formatTime(task, now),
    formatTokens(task),
    task.label,
    task.chatId ?? "—",
  ];
}

/**
 * Pad every column to its widest cell. Colors are applied after padding
 * (the state cell) so ANSI escapes never skew the width math.
 */
function renderTable(tasks: TaskRecord[], now: number): void {
  const rows = tasks.map((t) => toRow(t, now));
  const widths = HEADER.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => r[col]!.length)),
  );
  const pad = (row: Row) => row.map((cell, col) => cell.padEnd(widths[col]!));

  console.log(`  ${pc.dim(pad(HEADER).join("  "))}`);
  tasks.forEach((task, i) => {
    const cells = pad(rows[i]!);
    cells[1] =
      colorState(task.state) + " ".repeat(widths[1]! - task.state.length);
    console.log(`  ${cells.join("  ")}`);
  });
  console.log();
}

/** Settled runs from the journal, minus any already in the live table. */
async function journalTasks(
  liveTasks: readonly TaskRecord[],
  limit: number,
): Promise<TaskRecord[]> {
  const { readJournal } = await import("../storage/journal.js");
  const seen = new Set(liveTasks.map((t) => `${t.id}:${t.queuedAt}`));
  const historical: TaskRecord[] = [];
  for (const entry of readJournal({ type: "task.settled", limit })) {
    if (entry.event.type !== "task.settled") continue;
    const task = entry.event.task;
    // (id, queuedAt) identifies a run across surfaces — per-process ids
    // repeat between daemon runs, enqueue times don't.
    if (seen.has(`${task.id}:${task.queuedAt}`)) continue;
    seen.add(`${task.id}:${task.queuedAt}`);
    historical.push(task);
  }
  return historical;
}

export async function showTasks(all = false): Promise<void> {
  console.log();

  let tasks: TaskRecord[] = [];
  let daemonUp = true;
  if (all) {
    // History works without a daemon — fold in the live table only when
    // one is actually running.
    const instance = await findRunningInstance();
    if (instance?.port) {
      try {
        const body = (await fetchGateway(instance.port, "/tasks")) as {
          tasks?: TaskRecord[];
        };
        tasks = body.tasks ?? [];
      } catch {
        daemonUp = false;
      }
    } else {
      daemonUp = false;
    }
  } else {
    const port = await requireGatewayPort();
    if (port === null) return;
    try {
      const body = (await fetchGateway(port, "/tasks")) as {
        tasks?: TaskRecord[];
      };
      tasks = body.tasks ?? [];
    } catch (err) {
      console.log(
        `  ${pc.red("✖")} Could not read the task table: ${err instanceof Error ? err.message : err}\n`,
      );
      return;
    }
  }

  if (all) {
    if (!daemonUp) {
      console.log(
        `  ${pc.dim("Talon is not running — journal history only.")}`,
      );
    }
    try {
      tasks = [...tasks, ...(await journalTasks(tasks, 200))];
    } catch (err) {
      console.log(
        `  ${pc.red("✖")} Could not read the journal: ${err instanceof Error ? err.message : err}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (tasks.length === 0) {
    console.log(
      all
        ? `  ${pc.dim("No tasks — nothing live and the journal is empty.")}\n`
        : `  ${pc.dim("No tasks — the table starts empty on each daemon start. Older runs: talon ps --all")}\n`,
    );
    return;
  }
  renderTable(displayOrder(tasks), Date.now());
}

export async function killTask(rawId: string | undefined): Promise<void> {
  console.log();
  const id = Number(rawId);
  if (rawId === undefined || !Number.isInteger(id)) {
    console.log(
      `  ${pc.red("✖")} Usage: ${pc.cyan("talon kill <id>")} — ids come from ${pc.cyan("talon ps")}\n`,
    );
    return;
  }

  const port = await requireGatewayPort();
  if (port === null) return;

  let outcome: KillOutcome;
  try {
    outcome = (await fetchGateway(port, "/tasks/kill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    })) as KillOutcome;
  } catch (err) {
    console.log(
      `  ${pc.red("✖")} Kill request failed: ${err instanceof Error ? err.message : err}\n`,
    );
    return;
  }

  if (outcome.ok) {
    console.log(
      `  ${pc.green("●")} Task ${id} aborted — it settles as ${pc.magenta("killed")} once the backend honours the abort.\n`,
    );
    return;
  }
  switch (outcome.reason) {
    case "not-found":
      console.log(`  ${pc.red("✖")} No task ${id} in the table.\n`);
      return;
    case "finished":
      console.log(`  ${pc.dim("●")} Task ${id} already finished.\n`);
      return;
    case "not-killable":
      console.log(
        `  ${pc.yellow("!")} Task ${id} has no abort hook — its backend can't interrupt a running turn.\n`,
      );
      return;
  }
}
