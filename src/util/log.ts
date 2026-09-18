/**
 * Structured logging via pino — console + file output.
 *
 * Always runs at trace level (maximum verbosity) for debugging.
 * Logs to both:
 *   - stdout (pretty-printed for readability)
 *   - workspace/talon.log (JSON, append-only, for persistence)
 */

import pino from "pino";
import prettyStream from "pino-pretty";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  statSync,
  renameSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { Writable } from "node:stream";
import { dirs, files } from "./paths.js";

export type LogComponent =
  | "bot"
  | "bridge"
  | "bus"
  | "db"
  | "journal"
  | "kv"
  | "media"
  | "notify"
  | "agent"
  | "agents"
  | "pulse"
  | "userbot"
  | "users"
  | "watchdog"
  | "workspace"
  | "shutdown"
  | "file"
  | "history"
  | "sessions"
  | "settings"
  | "commands"
  | "cron"
  | "triggers"
  | "scripts"
  | "skills"
  | "dream"
  | "heartbeat"
  | "dispatcher"
  | "gateway"
  | "fusefs"
  | "plugin"
  | "teams"
  | "discord"
  | "whatsapp"
  | "native"
  | "mesh"
  | "config"
  | "access"
  | "github"
  | "mempalace"
  | "mem0"
  | "playwright"
  | "memory"
  | "stickers"
  | "backend-controller";

const LOG_FILE = files.log;

// Ensure .talon dir exists for log file
if (!existsSync(dirs.root)) {
  try {
    mkdirSync(dirs.root, { recursive: true });
  } catch {
    /* ignore */
  }
}

// Rotate log file on startup if it exceeds 10MB
const MAX_LOG_SIZE = 10 * 1024 * 1024;
try {
  if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > MAX_LOG_SIZE) {
    const rotated = `${LOG_FILE}.old`;
    try {
      unlinkSync(rotated);
    } catch {
      /* ignore */
    }
    renameSync(LOG_FILE, rotated);
  }
} catch {
  /* ignore */
}

// Suppress console output for terminal frontend (stdout belongs to the REPL)
let quiet = process.env.TALON_QUIET === "1";
if (!quiet) {
  try {
    const cfgPath = files.config;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (cfg.frontend === "terminal") quiet = true;
    }
  } catch {
    /* ignore */
  }
}

// Under vitest, skip the file transport entirely. Its worker thread
// flushes asynchronously, so a log call near the end of a test races
// the suite's tmp-HOME cleanup (unhandled ENOENT — observed via
// codex-one-shot on macOS) — and suites that don't mock HOME would
// pollute the real ~/.talon/talon.log. Console output still flows for
// suites that don't mock this module.
const IS_VITEST = process.env.VITEST === "true";

// In-process streams (pino.multistream), NOT worker-thread transports.
// `transport: { targets }` spawns a thread-stream worker that resolves the
// target module ("pino-pretty", "pino/file") by name at runtime — which
// fails in a `bun build --compile` standalone binary (no node_modules on
// disk: "unable to determine transport target for pino-pretty"). Wiring
// the same destinations as direct streams keeps formatting identical and
// runs everywhere, with no worker.
const streams: pino.StreamEntry[] = [];

// Console output (disabled in quiet mode), pretty-printed.
if (!quiet) {
  const consoleStream = prettyStream({
    colorize: true,
    ignore: "pid,hostname",
    translateTime: "HH:MM:ss",
  });
  // pino-pretty writes through a SonicBoom on fd 1 whose own error
  // handler removes itself after the first non-EPIPE failure
  // (pino-pretty/lib/utils/build-safe-sonic-boom.js). With stdout
  // redirected to a file on a full disk that leaves the pipeline's next
  // error unhandled — i.e. an uncaught exception raised from inside a
  // log call. One permanent listener closes that door; a dead console
  // is not worth a dead daemon.
  consoleStream.on("error", () => {});
  streams.push({ level: "trace", stream: consoleStream });
}

/** How long to wait before the first attempt to reopen a failed log file. */
const SINK_RETRY_MS = 30_000;
/** Ceiling for the doubling backoff between reopen attempts. */
const SINK_MAX_RETRY_MS = 5 * 60_000;

export type ResilientFileSinkOptions = {
  /** Opens the underlying file stream. Injection seam for tests. */
  open?: (path: string) => Writable;
  /** Where the pause/resume notices go. Defaults to the console sink. */
  notify?: (level: "warn" | "info", message: string) => void;
  /** First backoff step (default 30s). */
  retryMs?: number;
  /** Backoff ceiling (default 5 min). */
  maxRetryMs?: number;
};

/**
 * A log file destination that cannot take the process down.
 *
 * A bare `createWriteStream` handed to `pino.multistream` is a loaded
 * gun: when the disk fills (ENOSPC), or the file is unlinked under a
 * rotation (EBADF), or the fd goes bad (EIO), the stream emits `error`.
 * With no listener that is an uncaught exception — and it fires from
 * inside a log call, so the crash handler's own `logError` runs on a
 * logger that is already broken. That is how a full disk killed the
 * daemon on 2026-09-18: the process aborted mid-`/update` with no
 * shutdown, no pidfile cleanup, and no successor.
 *
 * This sink owns the file stream instead of exposing it. pino only ever
 * sees this object, which never emits `error` and never blocks:
 *   - write failures pause file logging and destroy the broken stream,
 *   - lines written while paused are DROPPED and counted (never
 *     buffered — the failure mode here is "no space", so growing a
 *     buffer is the last thing to do),
 *   - an unref'd timer retries the open on a 30s → 5min backoff,
 *   - the first write to land again resumes logging and reports how
 *     many lines were lost.
 * The console sink keeps working throughout, and carries the two
 * notices.
 */
export class ResilientFileSink extends Writable {
  private readonly path: string;
  private readonly openStream: (path: string) => Writable;
  private readonly notify: (level: "warn" | "info", message: string) => void;
  private readonly baseRetryMs: number;
  private readonly maxRetryMs: number;
  private inner: Writable | null = null;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private droppedWhileDown = 0;
  private down = false;

  constructor(path: string, opts: ResilientFileSinkOptions = {}) {
    // decodeStrings:false keeps pino's serialized lines as strings;
    // autoDestroy:false means a downstream failure can never tear this
    // object down — it is the only thing standing between a broken file
    // and the process.
    super({ decodeStrings: false, autoDestroy: false });
    this.path = path;
    this.openStream = opts.open ?? openLogFile;
    this.notify = opts.notify ?? notifyViaConsoleSink;
    this.baseRetryMs = opts.retryMs ?? SINK_RETRY_MS;
    this.maxRetryMs = opts.maxRetryMs ?? SINK_MAX_RETRY_MS;
    this.retryMs = this.baseRetryMs;
    this.openInner();
  }

  /** Lines discarded since the sink went down; cleared on recovery. */
  get dropped(): number {
    return this.droppedWhileDown;
  }

  /** True while file logging is paused (the console sink still runs). */
  get isDown(): boolean {
    return this.down;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const inner = this.inner;
    if (inner === null) {
      this.droppedWhileDown++;
    } else {
      try {
        inner.write(chunk as string, (err) => {
          if (!err) this.markHealthy();
        });
      } catch (err) {
        // Synchronous throw (write-after-destroy on a stream we have not
        // been told about yet) — same handling as an `error` event.
        this.fail(err);
      }
    }
    // Always report success: pino must never see this sink fail, and
    // backpressure here would stall whoever called log().
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.clearRetry();
    try {
      this.inner?.end();
    } catch {
      /* going away anyway */
    }
    callback();
  }

  override _destroy(
    _err: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.clearRetry();
    this.detachInner();
    callback(null);
  }

  private openInner(): void {
    try {
      const inner = this.openStream(this.path);
      inner.on("error", (err: Error) => {
        // Ignore errors from a stream we have already given up on.
        if (this.inner === inner) this.fail(err);
      });
      this.inner = inner;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Give up on the current stream and arm a reopen. Never throws. */
  private fail(err: unknown): void {
    const firstFailure = !this.down;
    this.detachInner();
    this.down = true;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    this.scheduleRetry(delay);
    if (!firstFailure) return; // a failed reopen is not news
    const code =
      (err as NodeJS.ErrnoException | undefined)?.code ??
      (err instanceof Error ? err.message : String(err));
    this.emitNotice(
      "warn",
      `Log file sink failed (${code}) — file logging paused, ` +
        `retrying in ${Math.round(delay / 1000)}s`,
    );
  }

  /** A write landed: the file is usable again. */
  private markHealthy(): void {
    if (!this.down) return;
    this.down = false;
    this.retryMs = this.baseRetryMs;
    const dropped = this.droppedWhileDown;
    this.droppedWhileDown = 0;
    this.emitNotice(
      "info",
      `Log file sink recovered — file logging resumed ` +
        `(${dropped} line(s) dropped while it was down)`,
    );
  }

  private detachInner(): void {
    const inner = this.inner;
    this.inner = null;
    if (inner === null) return;
    try {
      inner.removeAllListeners("error");
      // destroy() can surface one last error — swallow it here rather
      // than let it reach process-level uncaughtException.
      inner.on("error", () => {});
      inner.destroy();
    } catch {
      /* best effort */
    }
  }

  private scheduleRetry(delay: number): void {
    this.clearRetry();
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.openInner();
    }, delay);
    // A paused log sink must not hold the event loop open.
    timer.unref();
    this.retryTimer = timer;
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Notices are deferred: `fail()` can run inside pino's multistream
   * write loop, and logging re-entrantly from there would scramble the
   * metadata pino hangs off the stream for the rest of that loop.
   */
  private emitNotice(level: "warn" | "info", message: string): void {
    queueMicrotask(() => {
      try {
        this.notify(level, message);
      } catch {
        /* the notice is the least important thing here */
      }
    });
  }
}

function openLogFile(path: string): Writable {
  // 0600: turns and tool output land here — same sensitivity as history.
  return createWriteStream(path, { flags: "a", mode: 0o600 });
}

function notifyViaConsoleSink(level: "warn" | "info", message: string): void {
  if (level === "warn") logWarn("file", message);
  else log("file", message);
}

// JSON file output (always active outside test runs).
if (!IS_VITEST) {
  streams.push({ level: "trace", stream: new ResilientFileSink(LOG_FILE) });
}

const logger =
  streams.length > 0
    ? pino({ level: "trace" }, pino.multistream(streams))
    : pino({ level: "silent" });

/**
 * Emit one record. A logger that throws is worse than a silent one: the
 * throw lands on whoever called log(), which at shutdown is a signal
 * handler or a crash handler, and a throw there takes the daemon down —
 * pino-pretty's SonicBoom, for one, throws "SonicBoom destroyed"
 * synchronously on every write once a failure has destroyed it. Nothing
 * a sink does may escape this module.
 */
function emit(write: () => void): void {
  try {
    write();
  } catch {
    /* a broken logger must never become a broken daemon */
  }
}

export function log(component: LogComponent, message: string): void {
  emit(() => logger.info({ component }, message));
}

export function logError(
  component: LogComponent,
  message: string,
  err?: unknown,
): void {
  if (err instanceof Error) {
    // Capture both the concise message (for log consumers that look at `err`)
    // and the full stack (for diagnostics). pino-pretty renders the `stack`
    // field on its own line; JSON consumers can read either field.
    emit(() =>
      logger.error({ component, err: err.message, stack: err.stack }, message),
    );
  } else if (err !== undefined) {
    emit(() => logger.error({ component, err: String(err) }, message));
  } else {
    emit(() => logger.error({ component }, message));
  }
}

export function logWarn(component: LogComponent, message: string): void {
  emit(() => logger.warn({ component }, message));
}

export function logDebug(component: LogComponent, message: string): void {
  emit(() => logger.debug({ component }, message));
}

// Expose logger to plugins running in the same process
(globalThis as Record<string, unknown>).__talonLog = log;
(globalThis as Record<string, unknown>).__talonLogError = logError;
(globalThis as Record<string, unknown>).__talonLogWarn = logWarn;
