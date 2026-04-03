/**
 * Keyword watch actions: watch, unwatch, list watches.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionRegistry } from "./index.js";

type KeywordWatch = {
  keyword: string;
  chatId?: number;
  createdAt: string;
};

export function registerWatchActions(registry: ActionRegistry) {
  registry.set("watch_keyword", async (body) => {
    const keyword = String(body.keyword ?? "").trim();
    if (!keyword) return { ok: false, error: "keyword is required" };
    const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
    let watches: KeywordWatch[] = [];
    try { watches = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[]; } catch { /* new */ }
    const newChatId = body.chat_id ? Number(body.chat_id) : undefined;
    watches = watches.filter((w) => !(w.keyword.toLowerCase() === keyword.toLowerCase() && w.chatId === newChatId));
    watches.push({ keyword, chatId: newChatId, createdAt: new Date().toISOString() });
    mkdirSync(resolve(process.env.HOME ?? "/root", ".talon/workspace"), { recursive: true });
    writeFileSync(watchesPath, JSON.stringify(watches, null, 2));
    return { ok: true, keyword, chat_id: newChatId, total_watches: watches.length };
  });

  registry.set("unwatch_keyword", async (body) => {
    const keyword = String(body.keyword ?? "").trim();
    if (!keyword) return { ok: false, error: "keyword is required" };
    const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
    let watches: KeywordWatch[] = [];
    try { watches = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[]; } catch { return { ok: false, error: "No watches configured" }; }
    const before = watches.length;
    watches = watches.filter((w) => w.keyword.toLowerCase() !== keyword.toLowerCase());
    writeFileSync(watchesPath, JSON.stringify(watches, null, 2));
    return { ok: true, removed: before - watches.length, remaining: watches.length };
  });

  registry.set("list_watches", async () => {
    const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
    try {
      const watches = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[];
      return { ok: true, count: watches.length, watches };
    } catch {
      return { ok: true, count: 0, watches: [] };
    }
  });
}
