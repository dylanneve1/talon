/**
 * Per-chat conversation state for the agy backend.
 *
 * `agy --print` is one-shot: each invocation spawns a fresh CLI. To
 * give a chat conversational continuity we need to thread the same
 * agy-assigned conversation UUID through every turn for that chat:
 *
 *   - First turn: spawn without `--conversation`. agy creates a new
 *     `.pb` under `~/.gemini/antigravity-cli/conversations/` and
 *     writes a startup banner like `Continuing last-used conversation
 *     (from cache): <uuid>`. We snapshot the conversation dir
 *     before/after the spawn to learn the new id.
 *   - Subsequent turns: spawn `agy --print --conversation <id>`.
 *
 * The id ↔ chat mapping is persisted to disk so it survives daemon
 * restarts (otherwise `/reset` would be implicit every time).
 *
 * `/reset` semantics: `forgetConversation(chatId)` drops the mapping,
 * so the next turn starts a fresh agy conversation.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { logError, logWarn } from "../../util/log.js";

const STATE_FILE = resolve(homedir(), ".talon/data/agy-conversations.json");

interface PersistedState {
  conversations: Record<string, string>;
}

let memoryState: Record<string, string> = {};
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (!existsSync(STATE_FILE)) return;
    const raw = readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed && typeof parsed.conversations === "object") {
      memoryState = { ...parsed.conversations };
    }
  } catch (err) {
    logWarn(
      "agent",
      `agy: failed to load conversation state (${
        err instanceof Error ? err.message : String(err)
      }) — starting empty`,
    );
    memoryState = {};
  }
}

function save(): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: PersistedState = { conversations: memoryState };
    writeFileAtomic.sync(STATE_FILE, JSON.stringify(data, null, 2) + "\n");
  } catch (err) {
    logError("agent", "agy: failed to persist conversation state", err);
  }
}

export function getConversation(chatId: string): string | undefined {
  load();
  return memoryState[chatId];
}

export function setConversation(chatId: string, conversationId: string): void {
  load();
  memoryState[chatId] = conversationId;
  save();
}

export function forgetConversation(chatId: string): void {
  load();
  if (memoryState[chatId] !== undefined) {
    delete memoryState[chatId];
    save();
  }
}
