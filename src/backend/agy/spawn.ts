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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { AGY_DEFAULT_BINARY, AGY_PRINT_TIMEOUT_MS } from "./constants.js";

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
 * Read the structured transcript agy writes for the conversation,
 * then return the **last** `PLANNER_RESPONSE` from the `MODEL` source
 * — that's the reply produced by the turn that just finished. The
 * stdout `agy --print --conversation <id>` produces is the full
 * transcript replayed every turn (by design), so reading the
 * structured log is the clean way to pick out just the latest reply.
 *
 * Returns `null` if the file doesn't exist, is malformed, or has no
 * model response — caller should fall back to stdout.
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
  // Walk lines bottom-up so the last MODEL/PLANNER_RESPONSE wins.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (
      obj.source === "MODEL" &&
      obj.type === "PLANNER_RESPONSE" &&
      typeof obj.content === "string" &&
      obj.content.length > 0
    ) {
      return obj.content;
    }
  }
  return null;
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

  const args: string[] = [
    "--print",
    "--dangerously-skip-permissions",
    "--print-timeout",
    `${Math.floor(timeoutMs / 1000)}s`,
  ];
  if (inputs.conversationId) {
    args.push("--conversation", inputs.conversationId);
  }
  args.push("--prompt", inputs.prompt);

  // Only snapshot the dir when we're going to need the new id — i.e.
  // we don't already have a conversation. Skips a `readdirSync` on the
  // hot resume path.
  const preSnapshot = inputs.conversationId ? null : snapshotConversations();

  return new Promise<AgyPrintResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

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
      const conversationId =
        inputs.conversationId ??
        (preSnapshot ? detectNewConversation(preSnapshot) : null);

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
      resolve({
        text,
        durationMs: Date.now() - started,
        exitCode,
        stderr,
        conversationId,
      });
    });
  });
}
