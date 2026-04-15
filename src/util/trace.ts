/**
 * Per-chat message trace — dumps full in/out messages to ~/.talon/data/traces/<chatId>.jsonl
 * for debugging. One JSON object per line, append-only.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "./paths.js";

function ensureDir(): void {
  if (!existsSync(dirs.traces)) mkdirSync(dirs.traces, { recursive: true });
}

export function traceMessage(
  chatId: string,
  direction: "in" | "out",
  text: string,
  meta?: Record<string, unknown>,
): void {
  try {
    ensureDir();
    const entry = {
      ts: new Date().toISOString(),
      dir: direction,
      text,
      ...meta,
    };
    appendFileSync(
      resolve(dirs.traces, `${chatId}.jsonl`),
      JSON.stringify(entry) + "\n",
    );
  } catch (err) {
    process.stderr.write(
      `[trace] Trace write failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}
