/**
 * Trigger supervisor — runs bot-authored scripts as long-running children
 * that signal back to fire wake-up messages into the originating chat.
 *
 * Contract (the "standard"):
 *   - Script body lives at ~/.talon/data/trigger-runs/<chatId>/<id>.<ext>
 *   - Talon spawns it under bash / python3 / node depending on `language`.
 *     `lua` is special: it runs inside Talon itself via the hidden
 *     `_lua-run` subcommand (WASM-sandboxed wasmoon VM, see
 *     core/scripting/lua-runner.ts) — still a child process, so the
 *     whole supervision contract below applies unchanged.
 *   - Mid-run protocol: any line starting with `TALON_FIRE: <text>` fires a
 *     wake-up message containing <text>; the script keeps running. Useful for
 *     long-running watchers that emit multiple events.
 *   - Exit 0 → final fire. The trailing stdout body becomes the wake prompt.
 *   - Exit non-zero → error fire. Tail of the log + exit code becomes the
 *     wake prompt so the bot can decide what to do.
 *   - Hard timeout: SIGTERM → 5s grace → SIGKILL. Fires a "timed_out" wake.
 *
 * Children are killed on Talon shutdown. By default a trigger does NOT
 * survive a restart — on startup any trigger left in `running`/`pending` is
 * marked `terminated` by the store loader, and the bot can decide whether
 * to recreate it. Triggers created with `persistent: true` are an exception:
 * they're parked in `pending` instead of `terminated` and `resumeAfterRestart`
 * re-spawns them (with an orphan-kill probe to avoid duplicates outside
 * cgroup-managed setups). Persistent triggers also skip the hard timeout.
 *
 * Supervision plumbing has two paths with identical policy:
 *   - Warden path (preferred): the script runs under the Rust
 *     talon-warden harness (native/talon-warden) in its OWN process
 *     group — cancel/timeout/shutdown kills reach grandchildren, the
 *     timeout is enforced out-of-process, and the warden tears the tree
 *     down itself if Talon dies uncleanly. Output arrives as framed
 *     NDJSON events (src/native/warden.ts) feeding the same line
 *     handlers.
 *   - Direct path (fallback): in-process spawn + readline, used when
 *     the warden binary isn't built (npm installs) or on Windows.
 *
 * Knows nothing about backend or frontend — dependencies are injected.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { execute as dispatcherExecute } from "../engine/dispatcher.js";
import {
  getAllTriggers,
  getTrigger,
  persistNow,
  updateTrigger,
  type Trigger,
  type TriggerStatus,
  FIRE_PAYLOAD_MAX_BYTES,
} from "../../storage/trigger-store.js";
import { log, logError, logWarn } from "../../util/log.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { selfInvocation } from "../../util/mcp-launcher.js";
import { LUA_RUN_SUBCOMMAND } from "../scripting/lua-runner.js";
import { spawnWarden, type WardenExitEvent } from "../../native/warden.js";

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

/** Trigger ids currently supervised by the Rust warden harness. */
const wardened = new Set<string>();
/**
 * Extra headroom before SIGKILLing a warden handle. The warden runs its
 * own TERM → grace → KILL escalation on the child's process group;
 * SIGKILLing the warden mid-escalation would orphan that cleanup.
 */
const WARDEN_GRACE_SLACK_MS = 2_000;

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

  if (spawnViaWarden(trigger, command)) return;
  spawnDirect(trigger, command);
}

/** Env contract every trigger child sees, on both supervision paths. */
function triggerEnv(trigger: Trigger): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TALON_TRIGGER_ID: trigger.id,
    TALON_TRIGGER_NAME: trigger.name,
    TALON_CHAT_ID: trigger.chatId,
  };
}

function clampedTimeoutMs(timeoutSeconds: number): number {
  return Math.min(Math.max(timeoutSeconds, 1), 7 * 24 * 60 * 60) * 1000;
}

/**
 * Open the trigger's append-mode run log and register it. Without the
 * error handler, a disk/permission failure on the log file would emit
 * an unhandled `error` event and crash the whole Node process. Log it
 * instead and let the trigger keep running — the script's behaviour
 * matters more than its diagnostic log.
 */
function openLogStream(trigger: Trigger): WriteStream {
  const logStream = createWriteStream(trigger.logPath, {
    flags: "a",
    mode: 0o600,
  });
  logStream.on("error", (err) =>
    logError("triggers", `log stream error [${trigger.id}]`, err),
  );
  logStreams.set(trigger.id, logStream);
  return logStream;
}

/**
 * Hard timeout — persistent triggers run without one. They're
 * long-running watchers whose lifetime is tied to Talon's, not to a
 * wall-clock deadline. If a persistent script hangs, the user can
 * trigger_cancel it explicitly. On the warden path the warden enforces
 * the same deadline out-of-process; this timer stays as the status
 * bookkeeper and a second line of defence — whichever fires first wins,
 * and both converge on status "timed_out" plus a kill.
 */
function armTimeout(trigger: Trigger): void {
  if (trigger.persistent) return;
  const timer = setTimeout(
    () => handleTimeout(trigger),
    clampedTimeoutMs(trigger.timeoutSeconds),
  );
  timer.unref();
  timeouts.set(trigger.id, timer);
}

/**
 * Spawn under the Rust warden harness. Returns false when the warden
 * binary is unavailable (npm install, Windows, TALON_NO_WARDEN) so the
 * caller falls back to the direct path. Once this returns true, warden
 * events drive the trigger to a terminal state through the same
 * handlers the direct path uses.
 */
function spawnViaWarden(
  trigger: Trigger,
  command: { cmd: string; args: string[] },
): boolean {
  const warden = spawnWarden({
    command: command.cmd,
    args: [...command.args, trigger.scriptPath],
    timeoutMs: trigger.persistent
      ? 0
      : clampedTimeoutMs(trigger.timeoutSeconds),
    graceMs: SIGTERM_GRACE_MS,
    env: triggerEnv(trigger),
    onStart: (event) => {
      // The child's pid arrives one event later than the direct path
      // learns it; the maps below were registered synchronously so
      // cancel/shutdown already work during this window.
      updateTrigger(trigger.id, {
        pid: event.pid,
        pidStarttime: event.pidStarttime ?? undefined,
      });
      // Same crash-window rationale as the direct path: flush the pid
      // so the next boot's orphan probe can see it.
      if (trigger.persistent) persistNow();
      log(
        "triggers",
        `Spawned "${trigger.name}" [${trigger.id}] pid=${event.pid} (${trigger.language}, warden)`,
      );
      logStreams
        .get(trigger.id)
        ?.write(
          `--- spawn ${new Date().toISOString()} pid=${event.pid} (warden) ---\n`,
        );
    },
    onLine: (event) =>
      event.stream === "stdout"
        ? handleStdoutLine(trigger.id, event.text)
        : handleStderrLine(trigger.id, event.text),
    onExit: (event) => handleWardenExit(trigger, event),
    onSpawnError: (message) => {
      // The warden can die before reporting a child start when a
      // cancel/shutdown/timeout TERM races its process startup. If a
      // status other than "running" was already recorded (spawnViaWarden
      // set "running" synchronously, so anything else means a handler
      // won that race), this is not a spawn failure — settle through
      // finalizeExit so cleanup, persistence, and wake fires stay on
      // the one path.
      const t = getTrigger(trigger.id);
      if (t && t.status !== "running") {
        finalizeExit(trigger.id, null, null).catch((err) =>
          logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
        );
        return;
      }
      // Mirror the direct path's fail-before-start: unwind the maps so
      // the trigger doesn't look alive, then record the failure.
      const timer = timeouts.get(trigger.id);
      if (timer) clearTimeout(timer);
      timeouts.delete(trigger.id);
      children.delete(trigger.id);
      wardened.delete(trigger.id);
      lineBuffers.delete(trigger.id);
      const stream = logStreams.get(trigger.id);
      if (stream) {
        stream.end();
        logStreams.delete(trigger.id);
      }
      failTrigger(trigger, message);
    },
  });
  if (!warden) return false;

  children.set(trigger.id, warden);
  wardened.add(trigger.id);
  lineBuffers.set(trigger.id, []);
  updateTrigger(trigger.id, { status: "running", startedAt: Date.now() });
  if (trigger.persistent) persistNow();
  openLogStream(trigger);
  armTimeout(trigger);
  return true;
}

function handleWardenExit(trigger: Trigger, event: WardenExitEvent): void {
  if (event.timedOut) {
    // The warden's out-of-process deadline fired before the TS timer —
    // record the same terminal status handleTimeout would have.
    const t = getTrigger(trigger.id);
    if (t && (t.status === "running" || t.status === "pending")) {
      updateTrigger(trigger.id, {
        status: "timed_out",
        lastError: `Timed out after ${trigger.timeoutSeconds}s`,
      });
      persistNow();
    }
  }
  finalizeExit(
    trigger.id,
    event.code,
    (event.signal as NodeJS.Signals | null) ?? null,
  ).catch((err) =>
    logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
  );
}

/** The original in-process supervision path — no warden binary needed. */
function spawnDirect(
  trigger: Trigger,
  command: { cmd: string; args: string[] },
): void {
  let child: ChildProcess;
  try {
    child = spawn(command.cmd, [...command.args, trigger.scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      // detached:false → child is in our process group → killed if we crash
      env: triggerEnv(trigger),
    });
  } catch (err) {
    failTrigger(
      trigger,
      `spawn failed: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  let started = false;
  let failedBeforeStart = false;
  const failBeforeStart = (message: string) => {
    if (failedBeforeStart) return;
    failedBeforeStart = true;
    failTrigger(trigger, message);
  };

  child.on("error", (err) => {
    if (!started) {
      failBeforeStart(
        `spawn failed: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    logError("triggers", `Child error [${trigger.id}]`, err);
  });

  if (!child.pid) {
    failBeforeStart("spawn returned without a PID");
    return;
  }

  started = true;
  children.set(trigger.id, child);
  lineBuffers.set(trigger.id, []);

  const startedAt = Date.now();
  updateTrigger(trigger.id, {
    status: "running",
    pid: child.pid,
    startedAt,
    pidStarttime: readPidStarttimeSync(child.pid),
  });
  // For persistent triggers, flush pid + pidStarttime to disk synchronously.
  // Without this, a crash within the ~10s autosave window would leave the
  // stored pid undefined and resumeAfterRestart() couldn't orphan-check on
  // the next boot — producing a duplicate child outside cgroup-managed setups.
  if (trigger.persistent) persistNow();

  log(
    "triggers",
    `Spawned "${trigger.name}" [${trigger.id}] pid=${child.pid} (${trigger.language})`,
  );

  const logStream = openLogStream(trigger);
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
    rlErr.on("line", (line) => handleStderrLine(trigger.id, line));
    rlErr.on("error", (err) =>
      logWarn("triggers", `stderr reader error [${trigger.id}]: ${err}`),
    );
  }

  child.on("exit", (code, signal) => {
    finalizeExit(trigger.id, code, signal).catch((err) =>
      logError("triggers", `finalizeExit failed [${trigger.id}]`, err),
    );
  });

  armTimeout(trigger);
}

function handleTimeout(trigger: Trigger): void {
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
  // Terminal status — persist now so a crash before the 10s autosave
  // doesn't leave us thinking this trigger is still "running" on next load.
  persistNow();
  killChild(trigger.id, c);
}

/**
 * Resolve the interpreter invocation for a script language. Shared
 * with the skills runner (core/skills/runner.ts) — skills use the
 * bash/python/node subset. Returns null when no interpreter is
 * available (currently only possible for bash on Windows).
 */
export function commandForLanguage(
  lang: Trigger["language"],
): { cmd: string; args: string[] } | null {
  switch (lang) {
    case "bash":
      return commandForBash();
    case "python":
      return {
        cmd: process.platform === "win32" ? "python" : "python3",
        args: [],
      };
    case "node":
      return { cmd: "node", args: [] };
    case "lua": {
      // Lua has no host interpreter dependency: Talon re-invokes its own
      // entrypoint with the `_lua-run` subcommand (same self-invocation
      // shape as MCP supervision) and runs the script in a WASM-sandboxed
      // wasmoon VM. Works for tsx source runs (loader flags ride along in
      // execArgv) and bun-compiled binaries (embedded argv[1] omitted —
      // the binary re-invokes itself). The spawn() above appends
      // trigger.scriptPath, which is exactly the runner's argv contract.
      const inv = selfInvocation(LUA_RUN_SUBCOMMAND);
      return { cmd: inv.command, args: inv.args };
    }
  }
}

let _bashCommand: { cmd: string; args: string[] } | null | undefined =
  undefined;

function commandForBash(): { cmd: string; args: string[] } | null {
  if (_bashCommand !== undefined) return _bashCommand;
  const candidates =
    process.platform === "win32"
      ? [
          "bash",
          "C:\\Program Files\\Git\\bin\\bash.exe",
          "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ]
      : ["bash"];
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["-lc", "exit 0"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (probe.status === 0) {
      _bashCommand = { cmd, args: [] };
      return _bashCommand;
    }
  }
  _bashCommand = null;
  return null;
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

/** Stderr lines are logged and buffered (tagged) but never fire wakes. */
function handleStderrLine(triggerId: string, line: string): void {
  const stream = logStreams.get(triggerId);
  stream?.write(`[stderr] ${line}\n`);
  pushBufferLine(triggerId, `[stderr] ${line}`);
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
  // Terminal status — persist now so cancel survives a crash before autosave.
  persistNow();
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
    const t = getTrigger(id);
    if (t?.persistent) {
      // Park persistent triggers in "pending" so resumeAfterRestart() respawns
      // them on next startup. Keep the stored pid — finalizeExit clears it
      // when the child actually exits (normal case, SIGTERM honoured). If the
      // child explicitly ignores SIGTERM (rare — `trap '' TERM` or equivalent)
      // and outlives Talon, the pid survives to disk so the next boot's
      // resumeAfterRestart() can SIGKILL the orphan before respawning.
      updateTrigger(id, { status: "pending" });
    } else {
      updateTrigger(id, {
        status: "terminated",
        lastError: "Killed by Talon shutdown",
      });
    }
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
  // Warden handles forward the TERM to the child's process group and run
  // their own grace escalation — give them headroom to finish it before
  // the last-resort SIGKILL here.
  const graceMs = wardened.has(id)
    ? SIGTERM_GRACE_MS + WARDEN_GRACE_SLACK_MS
    : SIGTERM_GRACE_MS;
  const grace = setTimeout(() => {
    if (children.has(id)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, graceMs);
  grace.unref();
}

// ── Exit handling ───────────────────────────────────────────────────────────

async function finalizeExit(
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  children.delete(id);
  wardened.delete(id);
  const timer = timeouts.get(id);
  if (timer) {
    clearTimeout(timer);
    timeouts.delete(id);
  }

  const stream = logStreams.get(id);
  if (stream) {
    // Await the flush so any caller observing `status === "fired"` is
    // guaranteed to find the exit footer on disk. Without the await,
    // a fast follow-up readFileSync(logPath) sees only `--- spawn …`
    // (the footer is still buffered) — observed as a flake on macOS CI.
    stream.write(`--- exit code=${code} signal=${signal} ---\n`);
    await new Promise<void>((resolve) => stream.end(resolve));
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

  // Persistent triggers parked as "pending" by shutdownTriggers must stay
  // "pending" so resumeAfterRestart respawns them on next boot. Skip the
  // status-rewrite and the endedAt stamp; just clear the PID and persist.
  if (t.persistent && t.status === "pending") {
    updateTrigger(id, { pid: undefined, pidStarttime: undefined });
    persistNow();
    log(
      "triggers",
      `Exited (persistent) "${t.name}" [${id}] code=${code} signal=${signal} — will respawn on next start`,
    );
    return;
  }

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
    pidStarttime: undefined,
    exitCode: code ?? undefined,
  });
  // Terminal status reached — persist immediately so a crash between here and
  // the next autosave tick doesn't lose the exit transition.
  persistNow();

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
  // Byte-correct truncation: keep the tail (most recent output) but never
  // exceed FIRE_PAYLOAD_MAX_BYTES *bytes* and never split a multi-byte char.
  return truncateUtf8Tail(text, FIRE_PAYLOAD_MAX_BYTES);
}

/**
 * Keep the tail of `text` so the resulting UTF-8 encoding is at most
 * `maxBytes` bytes. Never splits a multi-byte character — if the byte
 * boundary lands inside one, the leading continuation bytes are skipped.
 */
function truncateUtf8Tail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  // 10xxxxxx is a UTF-8 continuation byte — skip until we hit a lead byte.
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.toString("utf-8", start);
}

/**
 * Keep the head of `text` so the resulting UTF-8 encoding is at most
 * `maxBytes` bytes. Never splits a multi-byte character — if the byte
 * boundary lands inside one, trailing partial bytes are dropped.
 */
function truncateUtf8Head(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Walk backwards past any continuation byte we'd split on.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf-8", 0, end);
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

  // Truncate payload — we don't want a runaway script blowing out the prompt.
  // Byte-correct (not UTF-16 code-unit) so the cap matches FIRE_PAYLOAD_MAX_BYTES
  // and multi-byte characters don't get sliced mid-codepoint.
  const trimmed = truncateUtf8Head(payload ?? "", FIRE_PAYLOAD_MAX_BYTES);

  updateTrigger(triggerId, {
    fireCount: (t.fireCount ?? 0) + 1,
    lastFireAt: Date.now(),
    lastFirePayload: trimmed,
  });

  // Mid-run TALON_FIRE: signals reuse the "fired" enum value because there
  // isn't a distinct non-terminal status, but the prompt must not lie to the
  // model — show "signalled" so downstream handling can't mistake a mid-run
  // event for terminal completion.
  const promptStatus = terminal ? status : "signalled";

  const header = `[Trigger "${t.name}" (${t.id}) ${promptStatus}]`;
  const body = trimmed ? `${header}\n\n${trimmed}` : `${header}\n\n(no output)`;

  const prompt =
    `[System: TRIGGER FIRED. Status: ${promptStatus}. ` +
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
    // Persistent triggers were parked in "pending" by loadTriggers (crash
    // path) or shutdownTriggers (clean path) — respawn them silently. The
    // script body re-runs from the top (we don't checkpoint state), so it
    // must be safe to re-run. No wake fire so we don't spam the bot on
    // every Talon restart.
    if (t.persistent && t.status === "pending") {
      if (t.pid !== undefined) {
        killOrphan(t);
        updateTrigger(t.id, { pid: undefined, pidStarttime: undefined });
      }
      try {
        spawnTrigger(t);
        log("triggers", `Respawned persistent trigger "${t.name}" [${t.id}]`);
      } catch (err) {
        logError(
          "triggers",
          `Failed to respawn persistent trigger [${t.id}]`,
          err,
        );
      }
      continue;
    }
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

/**
 * Read field 22 (start time in jiffies since boot) from /proc/<pid>/stat.
 * Returns undefined if /proc isn't available (non-Linux) or the read fails.
 *
 * Parsing note: the `comm` field (2nd) is wrapped in parens and may itself
 * contain ')' — `/proc/<pid>/stat` is the only place in /proc that allows
 * this. The safe parse is to find the LAST ')' and split the rest on space.
 * After that split, index 19 corresponds to field 22 (state=3 → starttime=22,
 * so 22-3 = 19 positions further in the post-comm tail).
 */
function readPidStarttimeSync(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen < 0) return undefined;
    const tail = stat.slice(lastParen + 2).split(" ");
    const starttime = Number(tail[19]);
    return Number.isFinite(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Probe a stored PID from a previous Talon run and SIGKILL it if it's still
 * alive AND really is our former child (not a recycled PID). Used by
 * resumeAfterRestart to avoid duplicate-spawn when Talon crashed outside a
 * cgroup-managed environment and its persistent child got reparented to init
 * instead of being torn down.
 *
 * PID-reuse defence (Linux): we compare /proc/<pid>/stat field 22 (start
 * time in jiffies) against the value we captured at spawn. Start time is
 * monotonic per boot and unchanged by exec(), so a match means the PID
 * still belongs to our process — robust against both kernel PID reuse and
 * bash scripts that `exec` into a different binary mid-flight. On non-Linux
 * (no /proc, e.g. macOS dev), pidStarttime is undefined and we fall through
 * to SIGKILL — PID reuse on a sub-second restart cycle is rare enough to
 * accept in a dev environment.
 */
function killOrphan(t: Trigger): void {
  if (t.pid === undefined) return;
  try {
    process.kill(t.pid, 0);
  } catch {
    return; // dead — nothing to do
  }
  if (t.pidStarttime !== undefined) {
    const current = readPidStarttimeSync(t.pid);
    if (current !== undefined && current !== t.pidStarttime) {
      log(
        "triggers",
        `Orphan probe: pid=${t.pid} starttime ${current} ≠ stored ${t.pidStarttime} — PID reused, leaving alone`,
      );
      return;
    }
  }
  try {
    process.kill(t.pid, "SIGKILL");
    log("triggers", `Killed orphan pid=${t.pid} from previous "${t.name}"`);
  } catch {
    /* raced — exited between probe and kill */
  }
}

// Internal exports for tests
export const _internals = {
  children,
  timeouts,
  logStreams,
  wardened,
  handleStdoutLine,
  handleTimeout,
  finalizeExit,
  commandForLanguage,
};

function failTrigger(t: Trigger, message: string): void {
  logError("triggers", `Failed to spawn ${t.id}: ${message}`);
  updateTrigger(t.id, {
    status: "errored",
    lastError: message,
    endedAt: Date.now(),
  });
  // Terminal status — persist immediately. Callers like trigger_create re-read
  // the store right after spawnTrigger() returns and must see "errored", not
  // a stale snapshot from before the dirty flag is flushed.
  persistNow();
}
