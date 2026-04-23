/**
 * Shared lifecycle contract for internal self-healing plugins.
 *
 * Each built-in plugin (mempalace, github, playwright) implements
 * `SelfHealingPlugin` by exporting a `heal(ctx)` function. The core plugin
 * loader runs heal() exactly once during init, regardless of config flags —
 * the contract is "if this plugin is enabled, it takes care of itself".
 *
 * The intentional design choices:
 *   - No opt-in flag. Enabled = we install. This is Talon's spine, not
 *     a library someone imports.
 *   - Always idempotent. A second heal() call on a healthy install is a
 *     no-op (maybe a freshness check, nothing destructive).
 *   - Structured output. Every heal call emits a numbered, timed step
 *     summary so a user scanning logs can pinpoint the slow/failing step.
 *   - Never throw. Errors come back as typed PluginError values; throwing
 *     would bypass the runner's logging and leave the user guessing.
 */

import type { SpawnOptions, ChildProcess } from "node:child_process";
import type { PluginError } from "./errors.js";
import type { ProgressLogger } from "./progress.js";

export type HealStatus = "healthy" | "degraded" | "failed";

export type HealResult = Readonly<{
  /**
   * - `healthy`: plugin is installed at the expected version and usable.
   * - `degraded`: plugin is usable but something is off (version drift,
   *               missing optional dep). The MCP server will still be spawned.
   * - `failed`: plugin can't come up. The MCP server should not be spawned.
   */
  status: HealStatus;
  /** Human-readable identifier — e.g. "mempalace 3.3.2" or "chromium+mcp 0.0.70". */
  identifier: string;
  /** Populated when `status !== "healthy"`. */
  error?: PluginError;
  /** Total wall-clock time for heal (sum of step elapsed). */
  elapsedMs: number;
  /**
   * Short summary lines suitable for a one-shot status emit (`info`):
   * e.g. `["venv ready", "mempalace 3.3.2", "entity_detection en,ja"]`.
   */
  summary: readonly string[];
}>;

export interface HealContext {
  logger: ProgressLogger;
  /** Injectable spawn — used by runStreaming / runProbe. */
  spawnImpl?: (
    cmd: string,
    args: readonly string[],
    opts: SpawnOptions,
  ) => ChildProcess;
  /** Injectable filesystem probe (default: `node:fs.existsSync`). */
  existsSyncImpl?: (path: string) => boolean;
  /** Hard cap on total heal time in ms. Default 10 minutes. */
  totalTimeoutMs?: number;
}

export type HealFn = (ctx: HealContext) => Promise<HealResult>;

/**
 * Run a heal function with a timeout guard. If the timeout fires before
 * heal returns, we synthesize a timeout failure so the loader doesn't hang
 * forever on a misbehaving plugin.
 */
export async function runHeal(
  name: string,
  heal: HealFn,
  ctx: HealContext,
): Promise<HealResult> {
  const timeout = ctx.totalTimeoutMs ?? 10 * 60 * 1000;
  const start = Date.now();
  const race = await Promise.race([
    heal(ctx).then(
      (result) => ({ kind: "done" as const, result }),
      (err: unknown) => ({
        kind: "threw" as const,
        err:
          err instanceof Error
            ? err
            : new Error(typeof err === "string" ? err : JSON.stringify(err)),
      }),
    ),
    new Promise<{ kind: "timeout" }>((resolvePromise) =>
      setTimeout(() => resolvePromise({ kind: "timeout" }), timeout),
    ),
  ]);

  if (race.kind === "done") return race.result;

  const elapsedMs = Date.now() - start;
  if (race.kind === "timeout") {
    const error: PluginError = {
      kind: "timeout",
      message: `heal() exceeded ${timeout}ms`,
      hint: "investigate stuck subprocess; retry once, then file a bug",
    };
    ctx.logger.error(
      `heal timed out after ${Math.round(elapsedMs / 1000)}s — returning failed`,
    );
    return {
      status: "failed",
      identifier: name,
      error,
      elapsedMs,
      summary: [],
    };
  }

  // threw — unexpected, self-heal implementations should not throw
  const error: PluginError = {
    kind: "unknown",
    message: `heal() threw: ${race.err.message}`,
    hint: "unexpected implementation error; see logs and file a bug",
    details: race.err.stack,
  };
  ctx.logger.error(`heal threw unexpectedly: ${race.err.message}`);
  return {
    status: "failed",
    identifier: name,
    error,
    elapsedMs,
    summary: [],
  };
}
