/**
 * Trigger supervisor — runs bot-authored scripts as long-running children
 * that signal back to fire wake-up messages into the originating chat.
 *
 * Contract (the "standard"):
 *   - Script body lives at ~/.talon/data/trigger-runs/<chatId>/<id>.<ext>
 *   - Talon spawns it under bash / python3 / node depending on `language`
 *   - Mid-run protocol: any line starting with `TALON_FIRE: <text>` fires a
 *     wake-up message containing <text>; the script keeps running. Useful for
 *     long-running watchers that emit multiple events.
 *   - Exit 0 → final fire. The trailing stdout body becomes the wake prompt.
 *   - Exit non-zero → error fire. Tail of the log + exit code becomes the
 *     wake prompt so the bot can decide what to do.
 *   - Hard timeout: SIGTERM → 5s grace → SIGKILL. Fires a "timed_out" wake.
 *
 * Children are killed on Talon shutdown — triggers do NOT survive a restart.
 * On startup, any trigger left in `running`/`pending` is marked `terminated`
 * by the store loader, and the bot can decide whether to recreate it.
 *
 * Knows nothing about backend or frontend — dependencies are injected.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { execute as dispatcherExecute } from "./dispatcher.js";
import {
  getAllTriggers,
  getTrigger,
  updateTrigger,
  type Trigger,
  type TriggerStatus,
  FIRE_PAYLOAD_MAX_BYTES,
} from "../storage/trigger-store.js";
import { log, logError, logWarn } from "../util/log.js";
import { appendDailyLog } from "../storage/daily-log.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

type TriggerDeps = {
  /** Used for terminal "fired"/"errored" wake prompts that go through the model. */
  execute: typeof dispatcherExecute;
};

let deps: TriggerDeps | null = null;

/** Live child handles, keyed by trigger id. */
const children = new Map<string, ChildProcess>();
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
const logStreams = new Map<string, WriteStream>();
/** In-memory line buffer per trigger (most recent N stdout+stderr lines).
 *  Used for fire payloads so we don't have to wait on the log file flushing. */
const lineBuffers = new Map<string, string[]>();
const LINE_BUFFER_MAX = 80;

const SIGTERM_GRACE_MS = 5_000;
const FIRE_PREFIX = "TALON_FIRE:";

export function initTriggers(d: TriggerDeps): void {
  deps = d;
  log("triggers", "Initialized");
}

/** Number of triggers currently running. */
export function getRunningCount(): number {
  return children.size;
}

// ── Spawning ────────────────────────────────────────────────────────────────

/**
 * Spawn a trigger's script as a supervised child process.
 *
 * Idempotent: if a child is already alive for this id, returns silently.
 */
export function spawnTrigger(trigger: Trigger): void {
  if (children.has(trigger.id)) return;

  const command = commandForLanguage(trigger.language);
  if (!command) {
    failTrigger(trigger, `Unsupported language: ${trigger.language}`);
    return;
  }

  let child: ChildProcess;
  try {
    child = spawn(command.cmd, [...command.args, trigger.scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      // detached:false → child is in our process group → killed if we crash
      env: {
        ...process.env,
        TALON_TRIGGER_ID: trigger.id,
        TALON_TRIGGER_NAME: trigger.name,
        TALON_CHAT_ID: trigger.chatId,
      },
    });
  } catch (err) {
    failTrigger(
      trigger,
      `spawn failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  if (!child.pid) {
    failTrigger(trigger, "spawn returned without a PID");
    return;
  }

  children.set(trigger.id, child);
  lineBuffers.set(trigger.id, []);

  const startedAt = Date.now();
  updateTrigger(trigger.id, {
    status: "running",
    pid: child.pid,
    startedAt,
  });

  log(
    "triggers",
    `Spawned "${trigger.name}" [${trigger.id}] pid=${child.pid} (${trigger.language})`,
  );

  const logStream = createWriteStream(trigger.logPath, {
    flags: "a",
    mode: 0o600,
  });
  logStreams.set(trigger.id, logStream);
  logStream.write(
    `--- spawn ${new Date(startedAt).toISOString()} pid=${child.pid} ---\n`,
  );

  // Stream stdout line-by-line so we can intercept TALON_FIRE: signals
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => handleStdoutLine(trigger.id, line));
    rl.on("error", (err) =>
      logWarn("triggers", `stdout reader error [${trigger.id}]: ${err}`),
    );
  }
  if (child.stderr) {
    const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on("line", (line) => {
      const stream = logStreams.get(trigger.id);
      stream?.write(`[stderr] ${line}\n`);
      pushBufferLine(trigger.id, `[stderr] ${line}`);
    });
  }

  child.on("error", (err) => {
    logError("triggers", `Child error [${trigger.id}]`, err);
  });

  child.on("exit", (code, signal) => {
    finalizeExit(trigger.id, code, signal).catch((err) =>
      logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
    );
  });

  // Hard timeout
  const timeoutMs =
    Math.min(Math.max(trigger.timeoutSeconds, 1), 7 * 24 * 60 * 60) * 1000;
  const timer = setTimeout(() => {
    timeouts.delete(trigger.id);
    const c = children.get(trigger.id);
    if (!c) return;
    log(
      "triggers",
      `Timeout for "${trigger.name}" [${trigger.id}] after ${trigger.timeoutSeconds}s — killing`,
    );
    updateTrigger(trigger.id, {
      status: "timed_out",
      lastError: `Timed out after ${trigger.timeoutSeconds}s`,
    });
    killChild(trigger.id, c);
  }, timeoutMs);
  timer.unref();
  timeouts.set(trigger.id, timer);
}

function commandForLanguage(
  lang: Trigger["language"],
): { cmd: string; args: string[] } | null {
  switch (lang) {
    case "bash":
      return { cmd: "bash", args: [] };
    case "python":
      return { cmd: "python3", args: [] };
    case "node":
      return { cmd: "node", args: [] };
  }
}

// ── Stdout handling ─────────────────────────────────────────────────────────

function handleStdoutLine(triggerId: string, line: string): void {
  const stream = logStreams.get(triggerId);
  stream?.write(line + "\n");
  pushBufferLine(triggerId, line);

  if (line.startsWith(FIRE_PREFIX)) {
    const payload = line.slice(FIRE_PREFIX.length).trim();
    fireWake(triggerId, "fired", payload, /* terminal */ false).catch((err) =>
      logError("triggers", `mid-run fire failed [${triggerId}]`, err),
    );
  }
}

function pushBufferLine(triggerId: string, line: string): void {
  const buf = lineBuffers.get(triggerId);
  if (!buf) return;
  buf.push(line);
  if (buf.length > LINE_BUFFER_MAX) buf.splice(0, buf.length - LINE_BUFFER_MAX);
}

// ── Cancellation ────────────────────────────────────────────────────────────

/** Cancel a running trigger. Idempotent. */
export function cancelTrigger(id: string): boolean {
  const child = children.get(id);
  if (!child) return false;
  updateTrigger(id, {
    status: "cancelled",
    lastError: "Cancelled by user",
  });
  killChild(id, child);
  return true;
}

/** Kill all running children — called during shutdown. */
export async function shutdownTriggers(): Promise<void> {
  if (children.size === 0) return;
  log("triggers", `Shutting down ${children.size} running trigger(s)`);
  const ids = Array.from(children.keys());
  for (const id of ids) {
    const c = children.get(id);
    if (!c) continue;
    updateTrigger(id, {
      status: "terminated",
      lastError: "Killed by Talon shutdown",
    });
    killChild(id, c);
  }
  // Give children a brief grace window to actually exit so logs flush
  await new Promise((r) => setTimeout(r, 250));
}

function killChild(id: string, child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  const grace = setTimeout(() => {
    if (children.has(id)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, SIGTERM_GRACE_MS);
  grace.unref();
}

// ── Exit handling ───────────────────────────────────────────────────────────

async function finalizeExit(
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  children.delete(id);
  const timer = timeouts.get(id);
  if (timer) {
    clearTimeout(timer);
    timeouts.delete(id);
  }

  const stream = logStreams.get(id);
  if (stream) {
    stream.write(`--- exit code=${code} signal=${signal} ---\n`);
    stream.end();
    logStreams.delete(id);
  }

  const buffered = lineBuffers.get(id) ?? [];
  lineBuffers.delete(id);

  const t = getTrigger(id);
  if (!t) return;

  // Status was already set by cancel/timeout/shutdown handlers — only set
  // a terminal status here if the child exited on its own.
  let status: TriggerStatus = t.status;
  let payload: string | undefined;

  if (t.status === "running" || t.status === "pending") {
    if (code === 0) {
      status = "fired";
      payload = bufferAsPayload(buffered);
    } else {
      status = "errored";
      payload = bufferAsPayload(buffered, code ?? undefined);
    }
  } else {
    payload = bufferAsPayload(buffered);
  }

  updateTrigger(id, {
    status,
    endedAt: Date.now(),
    pid: undefined,
    exitCode: code ?? undefined,
  });

  log(
    "triggers",
    `Exited "${t.name}" [${id}] code=${code} signal=${signal} → ${status}`,
  );

  appendDailyLog(
    "Triggers",
    `Trigger "${t.name}" ended with status=${status}${
      code != null ? ` code=${code}` : ""
    }`,
  );

  // Fire a wake-up for terminal statuses so the bot sees what happened
  if (
    status === "fired" ||
    status === "errored" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "terminated"
  ) {
    await fireWake(id, status, payload, /* terminal */ true);
  }
}

/** Build a fire payload from the in-memory line buffer. */
function bufferAsPayload(buffer: string[], exitCode?: number): string {
  const head = exitCode != null ? `exit ${exitCode}` : undefined;
  const lines = head ? [head, ...buffer] : buffer;
  const text = lines.join("\n");
  return text.length > FIRE_PAYLOAD_MAX_BYTES
    ? text.slice(-FIRE_PAYLOAD_MAX_BYTES)
    : text;
}

// ── Wake-up firing ──────────────────────────────────────────────────────────

async function fireWake(
  triggerId: string,
  status: TriggerStatus,
  payload: string | undefined,
  terminal: boolean,
): Promise<void> {
  if (!deps) return;
  const t = getTrigger(triggerId);
  if (!t) return;

  // Truncate payload — we don't want a runaway script blowing out the prompt
  const trimmed = (payload ?? "").slice(0, FIRE_PAYLOAD_MAX_BYTES);

  updateTrigger(triggerId, {
    fireCount: (t.fireCount ?? 0) + 1,
    lastFireAt: Date.now(),
    lastFirePayload: trimmed,
  });

  const header = terminal
    ? `[Trigger "${t.name}" (${t.id}) ${status}]`
    : `[Trigger "${t.name}" (${t.id}) signalled]`;
  const body = trimmed ? `${header}\n\n${trimmed}` : `${header}\n\n(no output)`;

  const prompt =
    `[System: TRIGGER FIRED. Status: ${status}. ` +
    `This is a wake-up message from a long-running script you started earlier. ` +
    `Decide whether to message the user, take an action, or do nothing.]` +
    `\n\n${body}`;

  try {
    await deps.execute({
      chatId: t.chatId,
      numericChatId: t.numericChatId,
      prompt,
      senderName: "Trigger",
      isGroup: false,
      source: "trigger",
    });
  } catch (err) {
    logError("triggers", `wake dispatch failed [${triggerId}]`, err);
  }
}

// ── Resume on startup ───────────────────────────────────────────────────────

/**
 * After the dispatcher is wired, walk the store and clean up any leftover
 * state from a previous run. Triggers in non-terminal states are already
 * marked `terminated` by loadTriggers(); this is the place to fire their
 * wake-up so the bot sees what happened the moment it comes back.
 */
export async function resumeAfterRestart(): Promise<void> {
  if (!deps) return;
  for (const t of getAllTriggers()) {
    if (
      t.status === "terminated" &&
      t.lastFireAt === undefined &&
      t.endedAt &&
      Date.now() - t.endedAt < 5 * 60_000
    ) {
      await fireWake(t.id, "terminated", t.lastError, /* terminal */ true);
    }
  }
}

// Internal exports for tests
export const _internals = {
  children,
  timeouts,
  logStreams,
  handleStdoutLine,
  finalizeExit,
};

function failTrigger(t: Trigger, message: string): void {
  logError("triggers", `Failed to spawn ${t.id}: ${message}`);
  updateTrigger(t.id, {
    status: "errored",
    lastError: message,
    endedAt: Date.now(),
  });
}
