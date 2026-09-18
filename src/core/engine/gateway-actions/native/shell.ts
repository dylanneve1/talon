/**
 * Talking to a shell: POSIX single-quoting for a command Talon builds, and a
 * plain local spawn that collects exit code + stdout + stderr (used for the
 * ripgrep invocations behind glob/search).
 */

import { spawn } from "node:child_process";
import { createOutputCapture } from "../../../../util/exec-output.js";

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function runLocal(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env: process.env });
    const stdout = createOutputCapture();
    const stderr = createOutputCapture();
    child.stdout.on("data", stdout.push);
    child.stderr.on("data", stderr.push);
    child.on("error", () =>
      resolvePromise({
        code: 127,
        stdout: stdout.value(),
        stderr: stderr.value(),
      }),
    );
    child.on("close", (code) =>
      resolvePromise({
        code: code ?? 0,
        stdout: stdout.value(),
        stderr: stderr.value(),
      }),
    );
  });
}
