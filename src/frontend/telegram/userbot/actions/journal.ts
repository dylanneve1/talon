/**
 * Journal actions: add entries, read recent entries, and search the journal.
 */

import {
  addJournalEntry,
  getRecentEntries,
  searchJournal,
  type JournalEntryType,
} from "../../../../storage/journal.js";
import type { ActionRegistry } from "./index.js";

const VALID_TYPES: JournalEntryType[] = [
  "reflection",
  "decision",
  "observation",
  "plan",
  "error_analysis",
];

export function registerJournalActions(registry: ActionRegistry) {
  registry.set("add_journal_entry", async (body) => {
    const type = String(body.type ?? "") as JournalEntryType;
    if (!VALID_TYPES.includes(type)) {
      return { ok: false, error: `type must be one of: ${VALID_TYPES.join(", ")}` };
    }
    const content = String(body.content ?? "");
    if (!content) return { ok: false, error: "content is required" };

    const tags = Array.isArray(body.tags) ? (body.tags as string[]) : undefined;
    const relatedChats = Array.isArray(body.related_chats) ? (body.related_chats as string[]) : undefined;
    const relatedUsers = Array.isArray(body.related_users) ? (body.related_users as number[]) : undefined;

    const id = addJournalEntry(type, content, tags, relatedChats, relatedUsers);
    return { ok: true, id, text: `Journal entry recorded (${type}).` };
  });

  registry.set("get_journal", async (body) => {
    const limit = Number(body.limit ?? 10);
    const type = body.type ? (String(body.type) as JournalEntryType) : undefined;
    if (type && !VALID_TYPES.includes(type)) {
      return { ok: false, error: `type must be one of: ${VALID_TYPES.join(", ")}` };
    }

    const entries = getRecentEntries(limit, type);
    if (entries.length === 0) {
      return { ok: true, text: "No journal entries found.", entries: [] };
    }

    const formatted = entries.map((e) => {
      const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
      return `[${e.timestamp}] (${e.type})${tags} ${e.content}`;
    });

    return { ok: true, text: formatted.join("\n"), count: entries.length };
  });

  registry.set("search_journal", async (body) => {
    const query = String(body.query ?? "");
    if (!query) return { ok: false, error: "query is required" };

    const entries = searchJournal(query);
    if (entries.length === 0) {
      return { ok: true, text: `No journal entries matching "${query}".`, entries: [] };
    }

    const formatted = entries.map((e) => {
      const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
      return `[${e.timestamp}] (${e.type})${tags} ${e.content}`;
    });

    return { ok: true, text: formatted.join("\n"), count: entries.length };
  });
}
