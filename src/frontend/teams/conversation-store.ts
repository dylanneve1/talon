/**
 * Conversation reference store — persists Teams conversation references.
 *
 * Needed for proactive messaging (cron jobs, pulse, sendTyping outside turn).
 * Stores ConversationReference objects keyed by conversation ID string.
 * Persisted to workspace/teams-conversations.json so proactive messaging survives restarts.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ConversationReference } from "botbuilder";
import { log, logError } from "../../util/log.js";

const MAX_STORED_REFS = 1000;
let store = new Map<string, ConversationReference>();
let storePath = "";

export function initConversationStore(workspace: string): void {
  storePath = resolve(workspace, "teams-conversations.json");
  try {
    if (existsSync(storePath)) {
      const data = JSON.parse(readFileSync(storePath, "utf-8"));
      if (Array.isArray(data)) {
        for (const [key, ref] of data) {
          store.set(key, ref);
        }
      }
      log("teams", `Loaded ${store.size} conversation reference(s)`);
    }
  } catch {
    logError("teams", "Failed to load conversation references");
  }
}

export function saveConversationReference(
  conversationId: string,
  ref: Partial<ConversationReference>,
): void {
  store.set(conversationId, ref as ConversationReference);
  // Evict oldest if over cap
  if (store.size > MAX_STORED_REFS) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  flushConversationStore();
}

export function getConversationReference(
  conversationId: string,
): ConversationReference | undefined {
  return store.get(conversationId);
}

export function getAllConversationIds(): string[] {
  return [...store.keys()];
}

export function flushConversationStore(): void {
  if (!storePath) return;
  try {
    const dir = resolve(storePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic.sync(
      storePath,
      JSON.stringify([...store.entries()], null, 2) + "\n",
    );
  } catch (err) {
    logError("teams", `Failed to save conversation references: ${err instanceof Error ? err.message : err}`);
  }
}
