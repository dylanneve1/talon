/**
 * Subprocess helper with line-streaming output.
 *
 * Built specifically for plugin self-heal flows where we want:
 *   1. Full stdout/stderr captured for error reporting.
 *   2. Live output streamed to the progress logger so long-running
 *      operations (pip install, docker pull, playwright install) don't
 *      appear to hang.
 *   3. Deterministic timeout handling.
 *   4. Injectable spawn impl for tests.
 *
 * Node's built-in `execFile` doesn't stream — it returns on exit. `spawn`
 * with our own line-buffering and EOL normalization is the right primitive.
 */

import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import type { StepTracker } from "./progress.js";
import { classifySubprocessError, type PluginError } from "./errors.js";

export type RunResult = Readonly<{
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: PluginError;
  elapsedMs: number;
}>;

export interface RunOptions {
  /** Absolute timeout in ms. Enforced by SIGTERM + 5s grace SIGKILL. */
  timeoutMs: number;
  /** Step tracker to stream progress lines to. */
  tracker: StepTracker;
  /** Environment overrides. Merged onto process.env. */
  env?: Record<string, string | undefined>;
  /** Working directory. */
  cwd?: string;
  /** Injected for tests — defaults to `node:child_process.spawn`. */
  spawnImpl?: (
    cmd: string,
    args: readonly string[],
    opts: SpawnOptions,
  ) => ChildProcess;
}

/**
 * Spawn a subprocess, stream each output line through `tracker.stream()`,
 * and return a normalized result. Never throws — failures surface as
 * `ok: false` with a classified PluginError.
 */
export async function runStreaming(
  command: string,
  args: readonly string[],
  opts: RunOptions,
): Promise<RunResult> {
  const start = Date.now();
  const spawnFn = opts.spawnImpl ?? spawn;

  return new Promise<RunResult>((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | undefined;
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    // Windows Node 20.19+ rejects `.cmd`/`.bat` via spawn without
    // shell:true (CVE-2024-27980 mitigation). Detect that narrow case
    // and enable the shell — we control the args so the usual shell
    // injection surface doesn't apply here.
    const needsShell =
      process.platform === "win32" &&
      (command.toLowerCase().endsWith(".cmd") ||
        command.toLowerCase().endsWith(".bat"));

    const child = spawnFn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      shell: needsShell,
    });

    const carries: Record<"stdout" | "stderr", string> = {
      stdout: "",
      stderr: "",
    };
    const bufferFor = (sink: "stdout" | "stderr") => {
      return (chunk: Buffer | string) => {
        const text =
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (sink === "stdout") stdout += text;
        else stderr += text;
        // Normalize \r\n and \r (docker uses bare \r for progress bars).
        carries[sink] = (carries[sink] + text).replace(/\r\n?/g, "\n");
        let nl;
        while ((nl = carries[sink].indexOf("\n")) !== -1) {
          const line = carries[sink].slice(0, nl);
          carries[sink] = carries[sink].slice(nl + 1);
          if (line.length > 0) opts.tracker.stream(line);
        }
      };
    };

    const flushCarry = () => {
      // Some CLIs emit a final line without a trailing newline. Flush
      // whatever's left so the tracker sees the complete output rather
      // than silently swallowing the last status line.
      for (const sink of ["stdout", "stderr"] as const) {
        const remainder = carries[sink];
        if (remainder.length > 0) {
          carries[sink] = "";
          opts.tracker.stream(remainder);
        }
      }
    };

    child.stdout?.on("data", bufferFor("stdout"));
    child.stderr?.on("data", bufferFor("stderr"));

    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnError = err;
    });

    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      // Final flush for any unterminated trailing content on either stream.
      flushCarry();

      const elapsedMs = Date.now() - start;
      const failed =
        exitCode !== 0 || signal !== null || spawnError !== undefined;

      if (!failed) {
        resolvePromise({
          ok: true,
          exitCode,
          signal,
          stdout,
          stderr,
          elapsedMs,
        });
        return;
      }

      const error = classifySubprocessError({
        program: command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        spawnError,
      });
      resolvePromise({
        ok: false,
        exitCode,
        signal,
        stdout,
        stderr,
        error,
        elapsedMs,
      });
    });

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Grace period — if still alive after 5s, SIGKILL.
      killHandle = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000);
    }, opts.timeoutMs);
  });
}

/**
 * Convenience: run a subprocess and return ONLY stdout. Used for short
 * read-only probes (version checks, image inspects). Errors resolve to
 * null — callers treat missing version as "not installed".
 */
export async function runProbe(
  command: string,
  args: readonly string[],
  opts: Omit<RunOptions, "tracker"> & { tracker?: StepTracker },
): Promise<string | null> {
  const tracker: StepTracker = opts.tracker ?? {
    ok: () => ({ index: 0, label: "", status: "ok", elapsedMs: 0 }),
    fail: () => ({ index: 0, label: "", status: "fail", elapsedMs: 0 }),
    skip: () => ({ index: 0, label: "", status: "skipped", elapsedMs: 0 }),
    stream: () => {},
  };
  const result = await runStreaming(command, args, {
    timeoutMs: opts.timeoutMs,
    tracker,
    env: opts.env,
    cwd: opts.cwd,
    spawnImpl: opts.spawnImpl,
  });
  if (!result.ok) return null;
  return result.stdout.trim();
}
