/**
 * Notes actions: save, get, list, delete, search notes.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionRegistry } from "./index.js";
import { indexNote, removeNoteFromIndex, searchByEmbedding, reindexAll, flushEmbeddingIndex } from "../../../../storage/note-embeddings.js";

export function registerNotesActions(registry: ActionRegistry) {
  registry.set("save_note", async (body) => {
    const key = String(body.key ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
    if (!key) return { ok: false, error: "key is required" };
    const content = String(body.content ?? body.value ?? "");
    const tags: string[] = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
    const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
    mkdirSync(notesDir, { recursive: true });
    const note = { key, content, tags, updatedAt: new Date().toISOString() };
    writeFileSync(resolve(notesDir, `${key}.json`), JSON.stringify(note, null, 2));
    await indexNote(key, content, tags);
    flushEmbeddingIndex();
    return { ok: true, key };
  });

  registry.set("get_note", async (body) => {
    const key = String(body.key ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
    if (!key) return { ok: false, error: "key is required" };
    const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
    try {
      const note = JSON.parse(readFileSync(resolve(notesDir, `${key}.json`), "utf8"));
      return { ok: true, ...note };
    } catch {
      return { ok: false, error: `Note "${key}" not found` };
    }
  });

  registry.set("list_notes", async (body) => {
    const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
    try {
      const files = readdirSync(notesDir).filter((f) => f.endsWith(".json"));
      const tag = body.tag ? String(body.tag) : null;
      const notes = files
        .map((f) => {
          try {
            const n = JSON.parse(readFileSync(resolve(notesDir, f), "utf8")) as { key: string; content?: string; tags?: string[]; updatedAt?: string };
            if (tag && !(n.tags ?? []).includes(tag)) return null;
            return { key: n.key, tags: n.tags ?? [], updatedAt: n.updatedAt, preview: String(n.content ?? "").slice(0, 120) };
          } catch { return null; }
        })
        .filter(Boolean);
      return { ok: true, count: notes.length, notes };
    } catch {
      return { ok: true, count: 0, notes: [] };
    }
  });

  registry.set("delete_note", async (body) => {
    const key = String(body.key ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
    if (!key) return { ok: false, error: "key is required" };
    const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
    try {
      unlinkSync(resolve(notesDir, `${key}.json`));
      removeNoteFromIndex(key);
      flushEmbeddingIndex();
      return { ok: true };
    } catch {
      return { ok: false, error: `Note "${key}" not found` };
    }
  });

  registry.set("search_notes", async (body) => {
    const query = String(body.query ?? "").trim();
    if (!query) return { ok: false, error: "query is required" };
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
    try {
      const files = readdirSync(notesDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
      // Build noteContents map
      const noteContents: Record<string, string> = {};
      const noteMeta: Record<string, { tags: string[]; updatedAt?: string; content: string }> = {};
      for (const f of files) {
        try {
          const n = JSON.parse(readFileSync(resolve(notesDir, f), "utf8")) as { key: string; content?: string; tags?: string[]; updatedAt?: string };
          const fullText = `${n.key} ${(n.tags ?? []).join(" ")} ${n.content ?? ""}`;
          noteContents[n.key] = fullText;
          noteMeta[n.key] = { tags: n.tags ?? [], updatedAt: n.updatedAt, content: String(n.content ?? "") };
        } catch { /* skip */ }
      }
      const results = await searchByEmbedding(query, noteContents, limit);
      const notes = results.map(r => ({
        key: r.key,
        score: Math.round(r.score * 1000) / 1000,
        method: r.method,
        tags: noteMeta[r.key]?.tags ?? [],
        updatedAt: noteMeta[r.key]?.updatedAt,
        preview: (noteMeta[r.key]?.content ?? "").slice(0, 300),
      }));
      return { ok: true, query, count: notes.length, notes };
    } catch {
      return { ok: true, query, count: 0, notes: [] };
    }
  });

  registry.set("reindex_notes", async () => {
    const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
    try {
      const files = readdirSync(notesDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
      const noteContents: Record<string, string> = {};
      for (const f of files) {
        try {
          const n = JSON.parse(readFileSync(resolve(notesDir, f), "utf8")) as { key: string; content?: string; tags?: string[] };
          noteContents[n.key] = `${(n.tags ?? []).join(" ")} ${n.content ?? ""}`;
        } catch { /* skip */ }
      }
      const count = await reindexAll(noteContents);
      return { ok: true, total: files.length, indexed: count };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
