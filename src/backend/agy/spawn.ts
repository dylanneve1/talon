/**
 * Spawn the agy CLI in `--print` mode and collect its stdout.
 *
 * `agy` reads the prompt from argv (`--prompt "..."`), runs one
 * non-interactive turn, prints the model response to stdout, and
 * exits. Auth is whatever's in `~/.gemini/antigravity-cli/` — no API
 * key needed here.
 *
 * This is deliberately the simplest possible backend transport: no
 * streaming, no tool calls, no MCP wiring. Adding MCP integration is
 * a separate task (it'd require writing a per-process MCP config that
 * agy picks up — agy reads `~/.gemini/config/mcp_config.json` by
 * default which would clobber the user's regular agy setup, so the
 * config-file path needs more design work).
 */

import { spawn } from "node:child_process";
import { AGY_DEFAULT_BINARY, AGY_PRINT_TIMEOUT_MS } from "./constants.js";

export interface AgyPrintResult {
  /** Text content the model produced. Trailing newline stripped. */
  text: string;
  /** Wall-clock time the spawn took. */
  durationMs: number;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** stderr collected for diagnostics. Empty if the run was clean. */
  stderr: string;
}

export interface AgyPrintInputs {
  /** Full prompt to send. System + user content already concatenated. */
  prompt: string;
  /** Override binary path. Defaults to whatever `agy` resolves to on $PATH. */
  binary?: string;
  /** Abort signal — `signal.abort()` SIGKILLs the child. */
  signal?: AbortSignal;
  /** Override timeout (ms). Defaults to {@link AGY_PRINT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export class AgyPrintError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "AgyPrintError";
  }
}

/**
 * Run `agy --print --dangerously-skip-permissions --prompt <text>` and
 * return its stdout. Throws {@link AgyPrintError} on non-zero exit.
 *
 * `--dangerously-skip-permissions` is required because agy's default
 * is to interactively prompt for tool-call approvals; in a daemon
 * context there's no operator to approve them. The flag's name is
 * agy's choice, not ours — we're forwarding it as-is.
 */
export async function runAgyPrint(
  inputs: AgyPrintInputs,
): Promise<AgyPrintResult> {
  const binary = inputs.binary ?? AGY_DEFAULT_BINARY;
  const timeoutMs = inputs.timeoutMs ?? AGY_PRINT_TIMEOUT_MS;
  const started = Date.now();

  return new Promise<AgyPrintResult>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "--print",
        "--dangerously-skip-permissions",
        "--print-timeout",
        `${Math.floor(timeoutMs / 1000)}s`,
        "--prompt",
        inputs.prompt,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      reject(
        new AgyPrintError(`agy --print exceeded ${timeoutMs}ms`, -1, stderr),
      );
    }, timeoutMs + 5_000);

    inputs.signal?.addEventListener(
      "abort",
      () => {
        if (settled) return;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      },
      { once: true },
    );

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      reject(new AgyPrintError(`agy spawn failed: ${err.message}`, -1, stderr));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        reject(
          new AgyPrintError(
            `agy --print exited ${exitCode}: ${stderr.trim().slice(0, 500)}`,
            exitCode,
            stderr,
          ),
        );
        return;
      }
      resolve({
        text: stdout.replace(/\n+$/, ""),
        durationMs: Date.now() - started,
        exitCode,
        stderr,
      });
    });
  });
}
