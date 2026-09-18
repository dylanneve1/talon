/**
 * Daemon control — the restart / dream actions the app fires from Settings.
 */

import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { isBunRuntime } from "../../../util/runtime.js";
import { logError } from "../../../util/log.js";
import { PKG_ROOT } from "../../../cli/context.js";
import { forceDream } from "../../../core/background/dream/index.js";

/**
 * Restart the daemon by spawning a detached `talon restart` — the same
 * command a human runs. It must be an independent, detached process: the
 * restart stops *this* process, so doing it in-process would kill us before
 * the successor is spawned. The child outlives us, tears the daemon down,
 * and brings a fresh one up. Mirrors `core/daemon/control.ts`'s own
 * source-vs-compiled-binary spawn recipe.
 */
function spawnDaemonRestart(): void {
  const isBunBinary =
    (process.argv[1] ?? "").includes("~BUN") ||
    (process.argv[1] ?? "").includes("$bunfs");
  const cmd = process.execPath;
  const args = isBunBinary
    ? ["restart"]
    : isBunRuntime()
      ? [resolve(PKG_ROOT, "src", "cli.ts"), "restart"]
      : [
          resolve(PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
          resolve(PKG_ROOT, "src", "cli.ts"),
          "restart",
        ];
  const cwd = isBunBinary ? dirname(process.execPath) : PKG_ROOT;
  const child = spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
    windowsHide: true,
  });
  child.unref();
}

/**
 * Daemon-level control actions the app fires from Settings. Kept minimal and
 * explicit — each maps to a well-understood operation the CLI already
 * exposes, so there's no new privileged surface beyond "what a local admin
 * could already do".
 */
export async function control(
  action: string,
): Promise<{ ok: boolean; message: string }> {
  switch (action) {
    case "restart":
      spawnDaemonRestart();
      return {
        ok: true,
        message: "Restarting Talon — back online in a few seconds.",
      };
    case "dream":
      // Fire-and-forget: a dream run can take a while; the app just needs
      // to know it started. forceDream throws if one is already running.
      try {
        void forceDream().catch((err) =>
          logError("native", "Manual dream run failed", err),
        );
        return { ok: true, message: "Dream started — consolidating memory." };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    default:
      return { ok: false, message: `Unknown control action: ${action}` };
  }
}
