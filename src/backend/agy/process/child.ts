/**
 * The per-chat Antigravity child process.
 *
 * agy has no SDK: the integration surface is one long-lived
 * `agy --input-format stream-json` process per chat, fed one
 * `{"event":"user",...}` line per turn on stdin and read line-by-line
 * on stdout. That shape is deliberate — the CLI's own docs call it
 * "significantly faster than running repeated commands with
 * `--continue`" because the process starts once and the conversation
 * stays warm.
 *
 * What this module owns:
 *
 *   - Spawning with the right flag set, cwd and `--conversation` for a
 *     resume, and tearing the child down through a
 *     SIGTERM → grace → SIGKILL ladder that never leaves a zombie.
 *   - Serialising turns: exactly one may be in flight. The dispatcher
 *     already serialises per chat, so a second concurrent turn is a
 *     bug, not a queue to build — it is rejected loudly.
 *   - Settling a turn on its `result` event, or on the child dying,
 *     whichever comes first.
 *   - Idle reaping, and the terminator kill: a turn in progress cannot
 *     be cancelled through the protocol, so `end_turn` kills the child
 *     and the next turn respawns it with `--conversation <id>`.
 *   - A stderr ring buffer, because that is the ONLY place the CLI
 *     reports `authentication required` and permission notices.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log, logWarn } from "../../../util/log.js";
import {
  parseAgyLine,
  type AgyEvent,
  type AgyResult,
  type AgyStepUpdate,
} from "../events.js";
import type { AgyEffort } from "../effort.js";
import {
  AGY_BASE_ARGS,
  AGY_IDLE_REAP_MS,
  AGY_KILL_GRACE_MS,
} from "../constants.js";

/** How much stderr to retain for diagnostics. */
const STDERR_TAIL_CHARS = 4000;

/** Spawn shape for one child. Two children differing here can't be reused. */
export interface AgySpawnSpec {
  binary: string;
  cwd: string;
  model: string;
  effort?: AgyEffort;
  /** Extra roots the agent may touch, passed as `--add-dir`. */
  addDirs?: readonly string[];
  /** Resume this conversation instead of starting a new one. */
  conversationId?: string;
  env?: NodeJS.ProcessEnv;
  /** Idle TTL before the child is reaped. Defaults to [AGY_IDLE_REAP_MS]. */
  idleMs?: number;
}

export interface AgyTurnHandlers {
  onStep?: (step: AgyStepUpdate) => void;
  onEvent?: (event: AgyEvent) => void;
}

/**
 * The close a terminator (or a user interrupt) produces. The message
 * contains "abort" on purpose: every backend's close-out path — and
 * `handler/message.ts: isTerminatorAbort` here — recognises the
 * expected end-of-turn close by that word, so a killed-on-purpose turn
 * settles as a normal completion rather than an error with a retry.
 */
export class AgyTurnAborted extends Error {
  constructor(reason: string) {
    super(`agy turn aborted (${reason})`);
    this.name = "AgyTurnAborted";
  }
}

/** The child died — with whatever stderr said about why. */
class AgyProcessExited extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "AgyProcessExited";
  }
}

/** Build the argv for one child, in a stable, assertable order. */
export function buildAgyArgs(spec: AgySpawnSpec): string[] {
  const args = [...AGY_BASE_ARGS, "--model", spec.model];
  if (spec.effort) args.push("--effort", spec.effort);
  if (spec.conversationId) args.push("--conversation", spec.conversationId);
  for (const dir of spec.addDirs ?? []) args.push("--add-dir", dir);
  return args;
}

/** True when two specs describe the same process and one can be reused. */
function sameSpec(a: AgySpawnSpec, b: AgySpawnSpec): boolean {
  return (
    a.binary === b.binary &&
    a.cwd === b.cwd &&
    a.model === b.model &&
    a.effort === b.effort &&
    (a.addDirs ?? []).join("\u0000") === (b.addDirs ?? []).join("\u0000")
  );
}

interface PendingTurn {
  resolve: (result: AgyResult) => void;
  reject: (err: unknown) => void;
  handlers: AgyTurnHandlers;
}

export class AgyChild {
  readonly spec: AgySpawnSpec;
  private readonly label: string;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrTail = "";
  private pending: PendingTurn | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private exited = false;
  /** Conversation id announced by `init` / carried on every event. */
  conversationId: string | undefined;
  /** Tool names the CLI advertised in `init`. */
  tools: string[] = [];

  constructor(label: string, spec: AgySpawnSpec) {
    this.label = label;
    this.spec = spec;
    this.conversationId = spec.conversationId;
  }

  get alive(): boolean {
    return this.proc !== null && !this.exited;
  }

  get stderrSnapshot(): string {
    return this.stderrTail;
  }

  /** Spawn the process. Idempotent — a live child is left alone. */
  start(): void {
    if (this.alive) return;
    const args = buildAgyArgs(this.spec);
    log(
      "agent",
      `[${this.label}] agy spawn: ${this.spec.binary} ${args.join(" ")}`,
    );
    const proc = spawn(this.spec.binary, args, {
      cwd: this.spec.cwd,
      env: this.spec.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.exited = false;
    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    proc.on("error", (err) => this.onExit(null, err.message));
    proc.on("close", (code) => this.onExit(code, null));
    this.armIdleTimer();
  }

  /**
   * Run one turn. Resolves with the turn's `result` event; rejects
   * with [AgyTurnAborted] when the child was killed mid-turn and
   * [AgyProcessExited] when it died on its own.
   */
  runTurn(prompt: string, handlers: AgyTurnHandlers = {}): Promise<AgyResult> {
    if (this.pending) {
      return Promise.reject(
        new Error(
          `agy: a turn is already in flight for ${this.label} — ` +
            `the dispatcher is expected to serialise per chat`,
        ),
      );
    }
    this.start();
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("agy: child failed to spawn"));
    this.clearIdleTimer();

    return new Promise<AgyResult>((resolve, reject) => {
      this.pending = { resolve, reject, handlers };
      const line = `${JSON.stringify({
        event: "user",
        message: { content: prompt },
      })}\n`;
      proc.stdin.write(line, (err) => {
        if (err) this.settleReject(err);
      });
    });
  }

  /**
   * Kill the child. Any in-flight turn rejects with [AgyTurnAborted],
   * carrying `reason` so the handler can tell a terminator kill from a
   * reset or an idle reap.
   */
  kill(reason: string): void {
    this.clearIdleTimer();
    const proc = this.proc;
    this.settleReject(new AgyTurnAborted(reason));
    if (!proc || this.exited) {
      this.proc = null;
      return;
    }
    log("agent", `[${this.label}] agy child kill (${reason})`);
    try {
      proc.stdin.end();
    } catch {
      /* already closed */
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        if (!this.exited) proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, AGY_KILL_GRACE_MS);
    timer.unref();
    this.proc = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl = this.stdoutBuf.indexOf("\n");
    while (nl >= 0) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      this.onLine(line);
      nl = this.stdoutBuf.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    const event = parseAgyLine(line);
    if (!event) return;
    const pending = this.pending;
    if (event.event === "init") {
      this.conversationId = event.conversation_id ?? this.conversationId;
      this.tools = event.init?.tools ?? [];
    } else if (event.event === "step_update") {
      const step = event.step_update;
      if (step?.conversation_id) this.conversationId = step.conversation_id;
      if (step) pending?.handlers.onStep?.(step);
    }
    pending?.handlers.onEvent?.(event);
    if (event.event === "result") {
      this.conversationId =
        event.result?.conversation_id ?? this.conversationId;
      this.settleResolve(event.result ?? {});
    }
  }

  private onStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  }

  private onExit(code: number | null, error: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.proc = null;
    this.clearIdleTimer();
    if (!this.pending) return;
    const detail =
      error ?? this.stderrTail.trim().split("\n").slice(-4).join("\n");
    this.settleReject(
      new AgyProcessExited(
        `agy exited (code ${code ?? "n/a"})${detail ? `: ${detail}` : ""}`,
        code,
        this.stderrTail,
      ),
    );
  }

  private settleResolve(result: AgyResult): void {
    const pending = this.pending;
    this.pending = null;
    this.armIdleTimer();
    pending?.resolve(result);
  }

  private settleReject(err: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.reject(err);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const ms = this.spec.idleMs ?? AGY_IDLE_REAP_MS;
    if (ms <= 0) return;
    this.idleTimer = setTimeout(() => {
      logWarn("agent", `[${this.label}] agy child idle for ${ms}ms — reaping`);
      this.onIdle?.(this.label);
      this.kill("idle");
    }, ms);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Set by the pool so an idle reap can also drop the MCP entries. */
  onIdle?: (label: string) => void;
}

// ── Pool ────────────────────────────────────────────────────────────────────

const children = new Map<string, AgyChild>();

/**
 * The live child for a chat, spawning one if needed.
 *
 * A child whose spec has drifted (model or effort changed, workspace
 * moved) is killed and replaced — those are spawn-time flags with no
 * runtime equivalent. The replacement inherits the conversation id, so
 * the conversation survives a model switch.
 */
export function ensureChild(chatId: string, spec: AgySpawnSpec): AgyChild {
  const existing = children.get(chatId);
  if (existing?.alive && sameSpec(existing.spec, spec)) return existing;
  if (existing) {
    const carried = existing.conversationId ?? spec.conversationId;
    existing.kill(existing.alive ? "respawn" : "dead");
    children.delete(chatId);
    spec = { ...spec, conversationId: carried };
  }
  const child = new AgyChild(chatId, spec);
  children.set(chatId, child);
  child.start();
  return child;
}

/** The child for a chat, if one exists (alive or not). */
export function getChild(chatId: string): AgyChild | undefined {
  return children.get(chatId);
}

/** Kill and forget a chat's child. Returns true when one was running. */
export function killChild(chatId: string, reason: string): boolean {
  const child = children.get(chatId);
  if (!child) return false;
  child.kill(reason);
  children.delete(chatId);
  return true;
}

/** Kill every child — daemon shutdown and the factory cleanup hook. */
export function killAllChildren(reason: string): void {
  // Snapshot the keys: killChild mutates the map as we go.
  const ids = childChatIds();
  for (const chatId of ids) killChild(chatId, reason);
}

/** Chat ids with a registered child. Test + diagnostics helper. */
export function childChatIds(): string[] {
  return [...children.keys()];
}
