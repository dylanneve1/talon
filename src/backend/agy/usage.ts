/**
 * Real-token-count extraction from agy's internal language server.
 *
 * Reverse-engineered via `strings` of the `agy` binary and runtime
 * probing. The trick:
 *
 *   - Every `agy --print` invocation spawns a process-local gRPC /
 *     Connect-RPC language server on a random port. The HTTP listener
 *     accepts JSON Connect-RPC ({@link https://connectrpc.com}); no
 *     protobuf schema needed on our side.
 *   - agy logs the bind line `Language server listening on random
 *     port at <N> for HTTP` early in startup. We tail the log file
 *     (which we pass via `--log-file`) to learn the port.
 *   - `POST /exa.language_server_pb.LanguageServerService/LoadTrajectory`
 *     with `{"cascadeId":"<conv-uuid>"}` registers the trajectory.
 *   - `POST /exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps`
 *     with the same cascadeId returns every step in the trajectory.
 *     Each MODEL step has `metadata.modelUsage` populated with
 *     `inputTokens`, `outputTokens`, `cacheReadTokens`,
 *     `thinkingOutputTokens`, `responseOutputTokens`.
 *
 * The LS dies when the `agy --print` process exits, so the query has
 * to happen *while agy is still running*. The caller (spawn.ts) polls
 * the port until either the spawn ends or a fresh step lands, then
 * returns the latest `modelUsage` it saw.
 */

import { existsSync, readFileSync } from "node:fs";

export interface AgyTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  model: string;
  /** Step index inside the trajectory — useful for "is this fresh?" checks. */
  stepIndex: number;
}

const LS_PORT_RE = /Language server listening on random port at (\d+) for HTTP\b/;

/**
 * Parse the agy log file for the HTTP port line. Returns the port
 * number (or `null` if not yet logged).
 */
export function readHttpPortFromLog(logPath: string): number | null {
  try {
    if (!existsSync(logPath)) return null;
    const raw = readFileSync(logPath, "utf-8");
    const m = raw.match(LS_PORT_RE);
    if (!m) return null;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface ConnectError {
  code?: string;
  message?: string;
}

/**
 * Connect-RPC client — POST JSON to the unary endpoint, return parsed
 * JSON response. Throws on transport or server-side error.
 */
async function call(
  port: number,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`agy LS ${method} HTTP ${res.status}`);
  }
  const parsed = (await res.json()) as unknown;
  if (
    parsed &&
    typeof parsed === "object" &&
    "code" in parsed &&
    typeof (parsed as ConnectError).code === "string"
  ) {
    const err = parsed as ConnectError;
    throw new Error(
      `agy LS ${method}: ${err.code}${err.message ? `: ${err.message}` : ""}`,
    );
  }
  return parsed;
}

interface ModelUsage {
  model?: string;
  inputTokens?: string | number;
  outputTokens?: string | number;
  thinkingOutputTokens?: string | number;
  responseOutputTokens?: string | number;
  cacheReadTokens?: string | number;
  apiProvider?: string;
}

interface StepMetadata {
  modelUsage?: ModelUsage;
}

interface TrajectoryStep {
  type?: string;
  status?: string;
  metadata?: StepMetadata;
}

interface TrajectoryStepsResponse {
  steps?: TrajectoryStep[];
}

function asNum(v: string | number | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Query the running agy LS for the latest model-usage step in the
 * given conversation. Returns `null` if the trajectory hasn't loaded
 * yet, no model step exists, or the LS is unreachable.
 *
 * Safe to call repeatedly — each call is idempotent. The caller polls
 * until the turn ends or a fresh step lands.
 */
export async function fetchLatestModelUsage(args: {
  port: number;
  cascadeId: string;
  signal?: AbortSignal;
}): Promise<AgyTurnUsage | null> {
  try {
    // LoadTrajectory wakes up the LS-side cache for this conversation.
    // It's idempotent — returns `{}` if already loaded.
    await call(args.port, "LoadTrajectory", { cascadeId: args.cascadeId }, args.signal);

    const stepsResp = (await call(
      args.port,
      "GetCascadeTrajectorySteps",
      { cascadeId: args.cascadeId },
      args.signal,
    )) as TrajectoryStepsResponse;

    const steps = stepsResp.steps ?? [];
    // Walk bottom-up — the last MODEL step with `modelUsage` is the
    // turn that just finished generating.
    for (let i = steps.length - 1; i >= 0; i--) {
      const usage = steps[i]?.metadata?.modelUsage;
      if (usage && usage.inputTokens !== undefined) {
        return {
          inputTokens: asNum(usage.inputTokens),
          outputTokens: asNum(usage.outputTokens),
          cacheReadTokens: asNum(usage.cacheReadTokens),
          thinkingTokens: asNum(usage.thinkingOutputTokens),
          model: usage.model ?? "agy",
          stepIndex: i,
        };
      }
    }
    return null;
  } catch {
    // Any failure (LS down, trajectory missing, fetch error) — caller
    // will fall back to estimation. Logged at the spawn site.
    return null;
  }
}
