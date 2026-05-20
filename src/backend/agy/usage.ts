/**
 * Real-token-count + context-window extraction from agy's internal
 * language server.
 *
 * Reverse-engineered via `strings` of the `agy` binary and runtime
 * probing. The trick:
 *
 *   - Every `agy --print` invocation spawns a process-local
 *     Connect-RPC language server on a random HTTP port. The HTTP
 *     listener accepts JSON Connect-RPC ({@link https://connectrpc.com});
 *     no protobuf schema needed on our side. (There's also a gRPC
 *     port over HTTPS — we don't use it.)
 *   - agy logs both `Language server listening on random port at <N>
 *     for HTTP` and `Starting conversation update stream for <uuid>`
 *     early in startup. Tailing `--log-file` gives us both the port
 *     and (for first turns) the freshly-minted conversation id without
 *     racing a directory snapshot.
 *   - `POST /exa.../GetCascadeTrajectoryGeneratorMetadata` returns
 *     one entry per Gemini API call agy makes for the conversation.
 *     Each entry has:
 *       * `stepIndices: [N]` — which trajectory steps it produced
 *       * `chatModel.usage` — `{inputTokens, outputTokens,
 *         cacheReadTokens, thinkingOutputTokens, responseOutputTokens,
 *         model}` — actual billed numbers, not estimates
 *       * `chatModel.responseModel` — the human-readable model id
 *         (e.g. `gemini-3-flash-a`)
 *   - `POST /exa.../GetAvailableModels` returns the full model
 *     catalog keyed by placeholder enum (MODEL_PLACEHOLDER_M132),
 *     including `maxTokens` (context window) and `displayName`.
 *
 * Why generator metadata, not raw trajectory steps:
 *
 *   - Multi-tool-call turns make several API calls inside one
 *     `agy --print` (write_to_file → run_command → write_to_file →
 *     final response). Reading "the last MODEL step with modelUsage"
 *     only catches *one* of those calls and undercounts billing.
 *     Generator metadata has one entry per API call so we can SUM
 *     them for true per-turn cost.
 *   - Step metadata has a known race: agy itself logs
 *     `"Detection of temporal skew in SetSteps … Skipping last step
 *     metadata extraction"` when the trajectory writer lags. Generator
 *     metadata is populated by a separate path that's already complete
 *     when the API call finishes.
 *
 * The LS dies when the `agy --print` process exits, so the query has
 * to happen *while agy is still running*. The caller (spawn.ts) polls
 * the port until either the spawn ends or generator metadata for the
 * current turn lands.
 */

import { existsSync, readFileSync } from "node:fs";

export interface AgyTurnUsage {
  /** Sum of input tokens across every API call in this turn. */
  inputTokens: number;
  /** Sum of (non-thinking) output tokens. */
  outputTokens: number;
  /** Sum of cache reads. */
  cacheReadTokens: number;
  /** Sum of thinking tokens. */
  thinkingTokens: number;
  /**
   * Human-readable model id from `chatModel.responseModel`
   * (e.g. `gemini-3-flash-a`). Falls back to the placeholder enum
   * (e.g. `MODEL_PLACEHOLDER_M132`) if the response model isn't set.
   */
  model: string;
  /**
   * Placeholder enum (`MODEL_PLACEHOLDER_M132` / `MODEL_GOOGLE_GEMINI_2_5_FLASH`
   * / ...). Use this to key into `fetchModelInfo` for context window
   * lookup. Empty string if not seen.
   */
  modelPlaceholder: string;
  /**
   * Highest trajectory step index seen across the summed entries.
   * Used by the caller to detect when fresh metadata has landed.
   */
  maxStepIndex: number;
  /** Number of generator-metadata entries summed (= # API calls). */
  callCount: number;
}

export interface AgyModelInfo {
  /** Placeholder enum, e.g. `MODEL_PLACEHOLDER_M132`. */
  placeholder: string;
  /** Display name from the model catalog, e.g. `Gemini 3.5 Flash (High)`. */
  displayName: string;
  /** Context window size in tokens (input + output combined). */
  contextWindow: number;
  /** Max output tokens per response. */
  maxOutputTokens: number;
}

const LS_PORT_RE =
  /Language server listening on random port at (\d+) for HTTP\b/;
const CONV_ID_RE = /Starting conversation update stream for ([0-9a-f-]{36})\b/;

/**
 * Parse the agy log file for the HTTP port line. Returns the port
 * number (or `null` if not yet logged). The `\b` in the regex matters:
 * `for HTTPS (gRPC)` also appears, and we want the HTTP one only.
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

/**
 * Parse the agy log file for the conversation-update-stream banner,
 * which gives us the conversation UUID for a turn that was started
 * without `--conversation` (first turn for a chat). Returns `null` if
 * not yet logged. Useful for kicking off LS polling on first turns
 * before the `.pb` snapshot diff would let us learn the id.
 */
export function readConversationIdFromLog(logPath: string): string | null {
  try {
    if (!existsSync(logPath)) return null;
    const raw = readFileSync(logPath, "utf-8");
    const m = raw.match(CONV_ID_RE);
    return m ? m[1] : null;
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

interface ChatModel {
  model?: string;
  usage?: ModelUsage;
  responseModel?: string;
}

interface GeneratorMetadataEntry {
  stepIndices?: number[];
  chatModel?: ChatModel;
}

interface GeneratorMetadataResponse {
  generatorMetadata?: GeneratorMetadataEntry[];
}

function asNum(v: string | number | undefined): number {
  if (v === undefined) return 0;
  const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : 0;
}

function maxStepIndex(entry: GeneratorMetadataEntry): number {
  if (!entry.stepIndices || entry.stepIndices.length === 0) return -1;
  let m = -Infinity;
  for (const i of entry.stepIndices) if (i > m) m = i;
  return Number.isFinite(m) ? m : -1;
}

/**
 * Fetch generator-metadata entries for the conversation and return
 * the SUM of `chatModel.usage` across entries whose maximum step
 * index is strictly greater than `floorStepIndex`.
 *
 * That floor is the caller's snapshot of "what existed in the
 * trajectory when this turn started" — any entry above it is work
 * the current turn produced. For first turns the caller passes -1
 * (everything is new).
 *
 * Returns `null` if no entries are above the floor yet (turn hasn't
 * made an API call we can see), or if the LS errored.
 */
export async function fetchTurnUsage(args: {
  port: number;
  cascadeId: string;
  floorStepIndex: number;
  signal?: AbortSignal;
}): Promise<AgyTurnUsage | null> {
  try {
    // LoadTrajectory primes the LS-side cache. Idempotent, returns
    // `{}` once already loaded.
    await call(
      args.port,
      "LoadTrajectory",
      { cascadeId: args.cascadeId },
      args.signal,
    );

    const resp = (await call(
      args.port,
      "GetCascadeTrajectoryGeneratorMetadata",
      { cascadeId: args.cascadeId },
      args.signal,
    )) as GeneratorMetadataResponse;

    const entries = resp.generatorMetadata ?? [];

    let inputSum = 0;
    let outputSum = 0;
    let cacheSum = 0;
    let thinkSum = 0;
    let highestStep = args.floorStepIndex;
    let callCount = 0;
    let latestModel = "";
    let latestPlaceholder = "";

    for (const entry of entries) {
      const step = maxStepIndex(entry);
      if (step <= args.floorStepIndex) continue;
      const usage = entry.chatModel?.usage;
      if (!usage) continue;
      inputSum += asNum(usage.inputTokens);
      outputSum +=
        asNum(usage.responseOutputTokens) || asNum(usage.outputTokens);
      cacheSum += asNum(usage.cacheReadTokens);
      thinkSum += asNum(usage.thinkingOutputTokens);
      callCount++;
      if (step > highestStep) {
        highestStep = step;
        latestModel = entry.chatModel?.responseModel ?? usage.model ?? "";
        latestPlaceholder = usage.model ?? entry.chatModel?.model ?? "";
      }
    }

    if (callCount === 0) return null;

    return {
      inputTokens: inputSum,
      outputTokens: outputSum,
      cacheReadTokens: cacheSum,
      thinkingTokens: thinkSum,
      model: latestModel || "agy",
      modelPlaceholder: latestPlaceholder,
      maxStepIndex: highestStep,
      callCount,
    };
  } catch {
    return null;
  }
}

/**
 * Query the current floor (highest stepIndex across all generator
 * entries already in the trajectory) so the caller can use it as a
 * "this turn's new entries are above this" cutoff. Returns -1 if no
 * entries exist or the LS errored — that's the correct floor for a
 * fresh conversation.
 */
export async function fetchTrajectoryFloor(args: {
  port: number;
  cascadeId: string;
  signal?: AbortSignal;
}): Promise<number> {
  try {
    await call(
      args.port,
      "LoadTrajectory",
      { cascadeId: args.cascadeId },
      args.signal,
    );
    const resp = (await call(
      args.port,
      "GetCascadeTrajectoryGeneratorMetadata",
      { cascadeId: args.cascadeId },
      args.signal,
    )) as GeneratorMetadataResponse;
    let m = -1;
    for (const entry of resp.generatorMetadata ?? []) {
      const s = maxStepIndex(entry);
      if (s > m) m = s;
    }
    return m;
  } catch {
    return -1;
  }
}

interface ArtifactSnapshotEntry {
  artifactName?: string;
  artifactAbsoluteUri?: string;
  content?: string;
  lastEdited?: string;
}

interface ArtifactSnapshotsResponse {
  artifactSnapshots?: ArtifactSnapshotEntry[];
}

export interface AgyArtifact {
  /** Friendly name (`robot`, `robot_mascot`). */
  name: string;
  /** Absolute filesystem path (decoded from `file://` URI), or `null` for text-only artifacts. */
  path: string | null;
  /** Inline text content for `.md`-style artifacts. */
  content: string | null;
  /** ISO timestamp of the last edit — used to dedupe across polls. */
  lastEdited: string;
}

/**
 * Fetch the current list of artifacts agy has materialized for this
 * conversation. Each artifact is either a file on disk (under
 * `~/.gemini/antigravity-cli/brain/<conv>/`) or an inline text blob.
 *
 * Used by spawn.ts to snapshot the artifact list before and after the
 * turn — the diff is what the model produced, which we can deliver
 * automatically over the user's chosen frontend even when the model
 * forgot to call the send tool.
 */
export async function fetchArtifactSnapshots(args: {
  port: number;
  cascadeId: string;
  signal?: AbortSignal;
}): Promise<AgyArtifact[]> {
  try {
    const resp = (await call(
      args.port,
      "GetArtifactSnapshots",
      { cascadeId: args.cascadeId },
      args.signal,
    )) as ArtifactSnapshotsResponse;
    const out: AgyArtifact[] = [];
    for (const a of resp.artifactSnapshots ?? []) {
      if (!a.artifactName) continue;
      let path: string | null = null;
      if (
        a.artifactAbsoluteUri &&
        a.artifactAbsoluteUri.startsWith("file://")
      ) {
        // `file:///home/dylan/...` → `/home/dylan/...`
        try {
          path = decodeURIComponent(new URL(a.artifactAbsoluteUri).pathname);
        } catch {
          path = null;
        }
      }
      out.push({
        name: a.artifactName,
        path,
        content: a.content ?? null,
        lastEdited: a.lastEdited ?? "",
      });
    }
    return out;
  } catch {
    return [];
  }
}

interface AvailableModelEntry {
  model?: string;
  displayName?: string;
  maxTokens?: string | number;
  maxOutputTokens?: string | number;
}

interface AvailableModelsResponse {
  response?: {
    models?: Record<string, AvailableModelEntry>;
  };
}

/**
 * Look up model metadata (context window, display name) for the
 * given placeholder enum (e.g. `MODEL_PLACEHOLDER_M132`). Returns
 * `null` if the LS errored or the placeholder isn't in the catalog.
 *
 * Cached per-call site — agy's catalog doesn't change mid-spawn, so
 * the caller can fetch once per spawn and reuse.
 */
export async function fetchModelInfo(args: {
  port: number;
  modelPlaceholder: string;
  signal?: AbortSignal;
}): Promise<AgyModelInfo | null> {
  try {
    const resp = (await call(
      args.port,
      "GetAvailableModels",
      {},
      args.signal,
    )) as AvailableModelsResponse;
    const models = resp.response?.models ?? {};
    for (const m of Object.values(models)) {
      if (m.model === args.modelPlaceholder) {
        const ctx = asNum(m.maxTokens);
        return {
          placeholder: args.modelPlaceholder,
          displayName: m.displayName ?? args.modelPlaceholder,
          contextWindow: ctx > 0 ? ctx : 1_048_576,
          maxOutputTokens: asNum(m.maxOutputTokens),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
