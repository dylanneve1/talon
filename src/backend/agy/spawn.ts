/**
 * Spawn the `agy` CLI in `--print` mode and capture its response.
 *
 * `agy` reads the prompt from `--prompt <text>` (argv) — or stdin if
 * we leave the flag off — runs one non-interactive turn against
 * Gemini, prints the model response on stdout, and exits. Auth is the
 * OAuth token at `~/.gemini/antigravity-cli/antigravity-oauth-token`
 * — no API key needed; whatever account `agy login` was last run
 * against handles the request.
 *
 * **Conversation continuity**: the first turn for a chat spawns
 * without `--conversation`, agy creates a new `.pb` under
 * `~/.gemini/antigravity-cli/conversations/`, and we snapshot the
 * directory before/after to learn the new id. Subsequent turns pass
 * `--conversation <id>` so agy resumes the same history. The id ↔
 * chat mapping is held in `state.ts`.
 *
 * **No system prompt**: agy already runs with its own persona /
 * system instructions baked in. Stacking Talon's full system prompt
 * on top fights it and tanks output quality, so the agy backend
 * delegates persona to agy itself.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { AGY_DEFAULT_BINARY, AGY_PRINT_TIMEOUT_MS } from "./constants.js";
import {
  readHttpPortFromLog,
  readConversationIdFromLog,
  fetchTrajectoryFloor,
  fetchTurnUsage,
  fetchModelInfo,
  type AgyTurnUsage,
  type AgyModelInfo,
} from "./usage.js";

const CONVERSATIONS_DIR = resolve(
  homedir(),
  ".gemini/antigravity-cli/conversations",
);

const BRAIN_DIR = resolve(homedir(), ".gemini/antigravity-cli/brain");

export interface AgyPrintResult {
  /** Text content the model produced. Trailing newline stripped. */
  text: string;
  /** Wall-clock time the spawn took. */
  durationMs: number;
  /** Process exit code (0 = success). */
  exitCode: number;
  /** stderr collected for diagnostics. Empty if the run was clean. */
  stderr: string;
  /**
   * The conversation id this turn ran against. For a resumed turn
   * (caller passed `conversationId`), echoed back unchanged. For a
   * first turn (caller passed `undefined`), the newly-minted id agy
   * assigned — `null` if we couldn't detect it (no new `.pb` showed
   * up, e.g. agy errored before writing the file).
   */
  conversationId: string | null;
  /**
   * Real token-usage data for this turn, pulled from agy's internal
   * language server's `GetCascadeTrajectoryGeneratorMetadata` RPC
   * while agy is still running, summed across every API call agy made
   * inside this single `--print`. `null` if the LS was unreachable,
   * the trajectory didn't load fast enough, or the turn errored
   * before any model call landed. See `usage.ts` for the protocol.
   */
  usage: AgyTurnUsage | null;
  /**
   * Model catalog entry for the model that produced this turn — gives
   * us the real `contextWindow` so `/status` doesn't have to hardcode
   * 1M. `null` if the LS lookup failed or we couldn't see a model
   * placeholder in the trajectory yet.
   */
  modelInfo: AgyModelInfo | null;
}

export interface AgyPrintInputs {
  /** Prompt text (user message). */
  prompt: string;
  /**
   * Resume this conversation. Omit for a fresh conversation — the
   * result's `conversationId` will carry the newly-assigned id.
   */
  conversationId?: string;
  /** Override binary path. Defaults to whatever `agy` resolves to on $PATH. */
  binary?: string;
  /** Abort signal — `signal.abort()` SIGTERMs the child. */
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
 * Snapshot the conversation directory's existing `.pb` filenames so
 * we can diff after the spawn and learn what agy created. Returns a
 * Set; missing dir is treated as empty.
 */
function snapshotConversations(): Set<string> {
  try {
    return new Set(
      readdirSync(CONVERSATIONS_DIR).filter((f) => f.endsWith(".pb")),
    );
  } catch {
    return new Set();
  }
}

/**
 * Find the newest `.pb` not present in the pre-spawn snapshot — that's
 * the new conversation agy just created. Returns the id (UUID, no
 * extension) or `null` if nothing new was written (typically means the
 * turn errored before agy could persist).
 */
function detectNewConversation(before: Set<string>): string | null {
  let newest: { id: string; mtime: number } | null = null;
  try {
    const entries = readdirSync(CONVERSATIONS_DIR).filter((f) =>
      f.endsWith(".pb"),
    );
    for (const file of entries) {
      if (before.has(file)) continue;
      const path = resolve(CONVERSATIONS_DIR, file);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) {
        newest = { id: file.replace(/\.pb$/, ""), mtime };
      }
    }
  } catch {
    return null;
  }
  return newest?.id ?? null;
}

/**
 * Names that mark a transcript entry as a tool call agy already
 * delivered to the user end of the chat. If one of these landed in
 * the current turn, the model's trailing `PLANNER_RESPONSE` is
 * narration ("I've sent a friendly greeting…") that Talon should
 * NOT forward as a second message — agy hosts it for the IDE
 * artifact view, but it's user-visible junk in a Telegram chat.
 *
 * Matched as a SUFFIX so we don't have to maintain the full
 * `mcp___talon__0_telegram-tools_send` path (which changes if the
 * key prefix or frontend name changes).
 */
const DELIVERY_TOOL_NAME_SUFFIXES = [
  "_telegram-tools_send",
  "_telegram-tools_react",
  "_telegram-tools_edit_message",
  "_telegram-tools_delete_message",
  "_teams-tools_send",
  "_discord-tools_send",
  "_telegram-tools_end_turn",
] as const;

function isDeliveryToolCall(name: unknown): boolean {
  if (typeof name !== "string") return false;
  for (const suffix of DELIVERY_TOOL_NAME_SUFFIXES) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Read the structured transcript agy writes for the conversation,
 * then return the **last** `PLANNER_RESPONSE` from the `MODEL` source
 * — that's the reply produced by the turn that just finished. The
 * stdout `agy --print --conversation <id>` produces is the full
 * transcript replayed every turn (by design), so reading the
 * structured log is the clean way to pick out just the latest reply.
 *
 * Returns `null` if the file doesn't exist, is malformed, or has no
 * model response — caller should fall back to stdout.
 *
 * Suppression: if the model called one of Talon's delivery tools
 * (`send` / `react` / etc.) during this turn, the trailing
 * PLANNER_RESPONSE is narration that the IDE artifact view would
 * render — in chat it lands as a duplicate / unwanted second
 * message. Return empty string in that case so the handler
 * doesn't forward anything beyond what the tool already sent.
 */
function readLatestModelTurn(conversationId: string): string | null {
  if (!conversationId) return null;
  const path = resolve(
    BRAIN_DIR,
    conversationId,
    ".system_generated/logs/transcript.jsonl",
  );
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  // Parse all lines, find the latest USER_INPUT index, then walk the
  // entries from there forward. The "this turn" slice is everything
  // after that USER_INPUT — the model's responses + any tool_calls
  // it made before producing its final PLANNER_RESPONSE.
  const lines = raw.split("\n");
  const entries: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj && typeof obj === "object") entries.push(obj);
    } catch {
      /* skip malformed */
    }
  }
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.source === "USER" || e.type === "USER_INPUT") {
      lastUserIdx = i;
      break;
    }
  }
  // Look at "this turn's" entries (after the latest USER_INPUT) for
  // any delivery-tool call and the final PLANNER_RESPONSE.
  let deliveryCalled = false;
  let plannerResponse: string | null = null;
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    const toolCalls = e.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        if (tc && typeof tc === "object" && isDeliveryToolCall((tc as { name?: unknown }).name)) {
          deliveryCalled = true;
        }
      }
    }
    if (
      e.source === "MODEL" &&
      e.type === "PLANNER_RESPONSE" &&
      typeof e.content === "string" &&
      (e.content as string).length > 0
    ) {
      plannerResponse = e.content as string;
    }
  }
  if (deliveryCalled) return "";
  return plannerResponse;
}

/**
 * Run one `agy --print` turn and capture stdout. Throws
 * {@link AgyPrintError} on non-zero exit.
 *
 * `--dangerously-skip-permissions` skips agy's interactive tool-call
 * confirmation prompts (no operator to approve them in a daemon).
 */
export async function runAgyPrint(
  inputs: AgyPrintInputs,
): Promise<AgyPrintResult> {
  const binary = inputs.binary ?? AGY_DEFAULT_BINARY;
  const timeoutMs = inputs.timeoutMs ?? AGY_PRINT_TIMEOUT_MS;
  const started = Date.now();

  // Per-spawn log file — we'll tail it for the LS port line so
  // `usage.ts` can call back into agy's internal language server
  // while it's still running. Lives in a temp dir we clean up at the
  // end so we don't leak files even on crash.
  const logDir = mkdtempSync(resolve(tmpdir(), "talon-agy-"));
  const logPath = resolve(logDir, "agy.log");

  const args: string[] = [
    "--print",
    "--dangerously-skip-permissions",
    "--print-timeout",
    `${Math.floor(timeoutMs / 1000)}s`,
    "--log-file",
    logPath,
  ];
  if (inputs.conversationId) {
    args.push("--conversation", inputs.conversationId);
  }
  args.push("--prompt", inputs.prompt);

  // Only snapshot the dir when we're going to need the new id — i.e.
  // we don't already have a conversation. Skips a `readdirSync` on the
  // hot resume path.
  const preSnapshot = inputs.conversationId ? null : snapshotConversations();

  return new Promise<AgyPrintResult>((resolveOuter, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let liveUsage: AgyTurnUsage | null = null;
    let liveModelInfo: AgyModelInfo | null = null;

    // Best-effort cleanup of the per-spawn log directory. Called on
    // every settle path (success / error / timeout / abort).
    const cleanupLogDir = () => {
      try {
        rmSync(logDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };

    // Background poller: tails the per-spawn log file for the HTTP
    // port (and, on first turns, the freshly-assigned conversation
    // id). Once both are known, polls
    // `GetCascadeTrajectoryGeneratorMetadata` and sums every entry
    // whose max stepIndex is strictly greater than the floor we
    // captured on the first successful poll. Each entry = one Gemini
    // API call; summing gives true per-turn billing for multi-tool
    // turns. Resolves the off-by-one we hit before (the previous
    // implementation grabbed any MODEL step's modelUsage and could
    // catch a previous turn's leftover step).
    //
    // Not awaited — it races the child's `close`. Whatever it has
    // when the child exits is what we report.
    const startUsagePoller = () => {
      let port: number | null = null;
      let cascadeId: string | null = inputs.conversationId ?? null;
      let floor: number | null = null;
      const pollAbort = new AbortController();

      const tick = async () => {
        if (settled || pollAbort.signal.aborted) return;
        if (port === null) {
          port = readHttpPortFromLog(logPath);
        }
        if (cascadeId === null) {
          cascadeId = readConversationIdFromLog(logPath);
        }
        if (port === null || cascadeId === null) {
          setTimeout(tick, 100);
          return;
        }
        // First time we have both: capture the trajectory floor. On
        // resume turns this is the max stepIndex from previous turns
        // — every entry we count after this is THIS turn's work. On
        // first turns it's -1 (nothing yet) so we count everything.
        if (floor === null) {
          floor = await fetchTrajectoryFloor({
            port,
            cascadeId,
            signal: pollAbort.signal,
          });
        }
        const u = await fetchTurnUsage({
          port,
          cascadeId,
          floorStepIndex: floor,
          signal: pollAbort.signal,
        });
        if (u) {
          liveUsage = u;
          // Probe model catalog once we know the placeholder for this
          // turn — gives us the real contextWindow / displayName. The
          // catalog doesn't change mid-spawn, so cache the first hit
          // and skip re-probing.
          if (liveModelInfo === null && u.modelPlaceholder) {
            liveModelInfo = await fetchModelInfo({
              port,
              modelPlaceholder: u.modelPlaceholder,
              signal: pollAbort.signal,
            });
          }
        }
        if (!settled) setTimeout(tick, 150);
      };
      void tick();

      child.once("close", () => pollAbort.abort());
      child.once("error", () => pollAbort.abort());
    };
    startUsagePoller();

    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      cleanupLogDir();
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
      cleanupLogDir();
      reject(new AgyPrintError(`agy spawn failed: ${err.message}`, -1, stderr));
    });

    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const exitCode = code ?? -1;
      const conversationId =
        inputs.conversationId ??
        (preSnapshot ? detectNewConversation(preSnapshot) : null);

      if (exitCode !== 0) {
        cleanupLogDir();
        reject(
          new AgyPrintError(
            `agy --print exited ${exitCode}: ${stderr.trim().slice(0, 500)}`,
            exitCode,
            stderr,
          ),
        );
        return;
      }
      // Prefer the structured transcript over stdout — `agy --print
      // --conversation <id>` replays the full transcript on stdout
      // every turn (it's a CLI display oddity, not the message we
      // want to forward). The transcript.jsonl has the latest
      // `PLANNER_RESPONSE/MODEL` entry verbatim with no duplication.
      let text: string | null = null;
      if (conversationId) {
        text = readLatestModelTurn(conversationId);
      }
      if (text === null) {
        // Fallback: cleaned stdout. Strip agy's `Warning: conversation
        // …` banner (it goes to STDOUT, not stderr) so it doesn't
        // leak into user-visible replies.
        text = stdout
          .replace(/^Warning: conversation "[^"]+" not found\.?\n?/gm, "")
          .replace(/\n+$/, "");
      } else {
        // Defensive trim — the transcript content is usually clean,
        // but agy sometimes appends a trailing newline.
        text = text.replace(/\n+$/, "");
      }
      cleanupLogDir();
      resolveOuter({
        text,
        durationMs: Date.now() - started,
        exitCode,
        stderr,
        conversationId,
        usage: liveUsage,
        modelInfo: liveModelInfo,
      });
    });
  });
}
