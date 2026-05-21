/**
 * Codex per-call token-usage reader.
 *
 * The Codex SDK only surfaces `Usage` via `turn.completed`, and that value
 * is **cumulative across every API call inside the turn** — for a 20-call
 * agentic turn the `input_tokens` field can hit 2–3M while the actual
 * last-call prompt size (= current context fill) sits around 150k.
 *
 * The Codex CLI writes a richer event stream to its rollout JSONL at
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`. Each
 * `token_count` event there carries:
 *
 *   - `total_token_usage`     — same cumulative figure the SDK gives us
 *   - `last_token_usage`      — the LAST API call's prompt + output sizes
 *   - `model_context_window`  — the model's actual context window
 *
 * For Talon's `/status` context display we want the per-call view, not the
 * cumulative one. This module tails the rollout file after a turn completes
 * and returns the last `token_count.last_token_usage.input_tokens` (which
 * IS the current context fill) plus the model's `context_window`.
 *
 * Why parse a file instead of fixing the SDK: the SDK ships a single
 * `Usage` shape and the Codex team isn't going to break it for a
 * Talon-shaped use case. The rollout JSONL is documented, stable across
 * Codex versions we've seen, and cheap to read — last `token_count` event
 * is usually the last line of the file, so reverse-scan is O(1) in the
 * common case.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexLastTokenUsage {
  /** Last API call's prompt size = current context fill in tokens. */
  contextTokens: number;
  /** Model's actual context window in tokens, if Codex reported it. */
  contextWindow?: number;
}

/**
 * Resolve `$CODEX_HOME`, falling back to `~/.codex`. Mirrors how the
 * Codex CLI resolves its data directory.
 */
function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/**
 * Find the rollout JSONL for a given `thread_id` by walking the most-recent
 * date directories under `$CODEX_HOME/sessions/`. Rollouts are filed under
 * `YYYY/MM/DD/rollout-<iso>-<thread_id>.jsonl`. Returns `null` if no
 * matching file is found (e.g. first run, or thread predates the date
 * window we walk).
 */
async function findRolloutFile(threadId: string): Promise<string | null> {
  const sessionsRoot = join(codexHome(), "sessions");

  let years: string[];
  try {
    years = (await readdir(sessionsRoot)).filter((y) => /^\d{4}$/.test(y));
  } catch {
    return null;
  }
  years.sort().reverse();

  for (const y of years) {
    let months: string[];
    try {
      months = (await readdir(join(sessionsRoot, y))).filter((m) =>
        /^\d{2}$/.test(m),
      );
    } catch {
      continue;
    }
    months.sort().reverse();

    for (const m of months) {
      let days: string[];
      try {
        days = (await readdir(join(sessionsRoot, y, m))).filter((d) =>
          /^\d{2}$/.test(d),
        );
      } catch {
        continue;
      }
      days.sort().reverse();

      for (const d of days) {
        const dir = join(sessionsRoot, y, m, d);
        let files: string[];
        try {
          files = await readdir(dir);
        } catch {
          continue;
        }
        const match = files.find((f) => f.endsWith(`-${threadId}.jsonl`));
        if (match) return join(dir, match);
      }
    }
  }
  return null;
}

/**
 * Read the last `token_count` event from the rollout JSONL for `threadId`.
 *
 * Returns `null` if the file can't be located, can't be read, or contains
 * no `token_count` events. Never throws — all failure modes degrade
 * silently to "no context info" so the caller can fall back to whatever
 * its old behaviour was.
 */
export async function readLastTokenCount(
  threadId: string,
): Promise<CodexLastTokenUsage | null> {
  const file = await findRolloutFile(threadId);
  if (!file) return null;

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }

  // Reverse-scan: the latest token_count event is almost always the last
  // non-empty line, so this typically loops once or twice.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = (obj as { payload?: { type?: string; info?: unknown } })
      ?.payload;
    if (payload?.type !== "token_count") continue;

    const info = payload.info as
      | {
          last_token_usage?: { input_tokens?: number };
          model_context_window?: number;
        }
      | undefined;
    const lastInput = info?.last_token_usage?.input_tokens;
    if (typeof lastInput !== "number" || !Number.isFinite(lastInput)) continue;

    const window = info?.model_context_window;
    return {
      contextTokens: lastInput,
      contextWindow:
        typeof window === "number" && Number.isFinite(window) && window > 0
          ? window
          : undefined,
    };
  }
  return null;
}
