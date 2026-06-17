/**
 * `talon logs` — pretty-print the last lines of the JSON log file and then
 * tail it live.
 */

import pc from "picocolors";
import { existsSync, readFileSync, watchFile } from "node:fs";
import { printBanner } from "./config.js";
import { LOG_FILE } from "./context.js";

const LEVEL_LABELS: Record<number, string> = {
  10: pc.dim("TRC"),
  20: pc.dim("DBG"),
  30: pc.blue("INF"),
  40: pc.yellow("WRN"),
  50: pc.red("ERR"),
  60: pc.bgRed(pc.white("FTL")),
};

export function formatLogLine(line: string): string {
  try {
    const obj = JSON.parse(line);
    const level = LEVEL_LABELS[obj.level as number] ?? pc.dim("???");
    const time = pc.dim(
      new Date(obj.time as number).toTimeString().slice(0, 8),
    );
    const comp = pc.cyan(((obj.component as string) ?? "?").padEnd(10));
    return `  ${time} ${level} ${comp} ${obj.msg}${obj.err ? pc.red(` (${obj.err})`) : ""}`;
  } catch {
    return `  ${line}`;
  }
}

export async function tailLogs(): Promise<void> {
  printBanner();
  if (!existsSync(LOG_FILE)) {
    console.log(
      `  No log file. Start the bot first: ${pc.cyan("talon start")}\n`,
    );
    return;
  }
  console.log(
    `  ${pc.dim("Tailing")} ${pc.dim(LOG_FILE)}\n  ${pc.dim("Press Ctrl+C to stop")}\n`,
  );
  const content = readFileSync(LOG_FILE, "utf-8");
  const lines = content.trim().split("\n");
  for (const line of lines.slice(-30)) console.log(formatLogLine(line));
  let lastSize = lines.length;
  watchFile(LOG_FILE, { interval: 500 }, () => {
    try {
      const nl = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
      for (let i = lastSize; i < nl.length; i++)
        console.log(formatLogLine(nl[i]));
      lastSize = nl.length;
    } catch {
      /* ignore */
    }
  });
  await new Promise(() => {});
}
