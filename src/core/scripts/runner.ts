/**
 * Script runner — run-to-completion execution of saved scripts.
 *
 * Unlike triggers (supervised long-running watchers with a fire
 * protocol), a script invocation is a plain subprocess: spawn the
 * interpreter on the script with the caller's args, capture output,
 * enforce a timeout, return the result to the calling turn. Local
 * execution — no model involvement, no token cost.
 *
 * Security posture matches triggers and the agent's Bash tool: the
 * bot account (its OS user, its workspace) is the boundary, not the
 * script contents.
 */

import { spawn } from "node:child_process";
import { dirs } from "../../util/paths.js";
import { log } from "../../util/log.js";
import { commandForLanguage } from "../background/triggers.js";
import type { Script } from "../../storage/script-store.js";

export const DEFAULT_SCRIPT_TIMEOUT_SECONDS = 60;
export const MAX_SCRIPT_TIMEOUT_SECONDS = 300;

/** Cap on captured stdout/stderr — keeps tool results context-friendly. */
const OUTPUT_CAP_CHARS = 16_000;

export type ScriptRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export function validateScriptTimeout(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0)
    return "Timeout must be a positive number";
  if (seconds > MAX_SCRIPT_TIMEOUT_SECONDS)
    return `Timeout exceeds max (${MAX_SCRIPT_TIMEOUT_SECONDS}s)`;
  return null;
}

/**
 * Run a script to completion. Resolves (never rejects) with the
 * captured result; spawn failures surface as `exitCode: null` with
 * the error message in stderr.
 */
export function runScript(
  script: Script,
  args: readonly string[] = [],
  timeoutSeconds = DEFAULT_SCRIPT_TIMEOUT_SECONDS,
): Promise<ScriptRunResult> {
  const command = commandForLanguage(script.language);
  if (!command) {
    return Promise.resolve({
      exitCode: null,
      stdout: "",
      stderr: `No ${script.language} interpreter available on this host`,
      timedOut: false,
      durationMs: 0,
    });
  }

  const t0 = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(
      command.cmd,
      [...command.args, script.scriptPath, ...args],
      {
        cwd: dirs.workspace,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // SIGKILL backstop for scripts that trap/ignore SIGTERM.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      // Settle without waiting for 'close': a grandchild that
      // inherited the stdio pipes (e.g. bash spawning `sleep`) keeps
      // them open after the direct child dies, so 'close' may never
      // fire. Whatever output was captured by now is the result.
      setTimeout(() => settle(null), 1_500).unref();
    }, timeoutSeconds * 1000);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_CHARS) stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_CHARS) stderr += chunk.toString("utf-8");
    });

    const settle = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - t0;
      log(
        "scripts",
        `ran "${script.name}" (exit=${exitCode ?? "n/a"}${timedOut ? ", TIMED OUT" : ""}, ${durationMs}ms)`,
      );
      resolvePromise({
        exitCode,
        stdout: stdout.slice(0, OUTPUT_CAP_CHARS),
        stderr: spawnError
          ? `${spawnError}\n${stderr}`.slice(0, OUTPUT_CAP_CHARS)
          : stderr.slice(0, OUTPUT_CAP_CHARS),
        timedOut,
        durationMs,
      });
    };

    child.on("error", (err) => settle(null, err.message));
    child.on("close", (code) => settle(code));
  });
}
