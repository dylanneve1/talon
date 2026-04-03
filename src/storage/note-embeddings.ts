/**
 * Semantic search for notes using Gemini text-embedding-004.
 * Falls back to TF-IDF when API is unavailable.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { dirs } from "../util/paths.js";

// ── Types ──────────────────────────────────────────────────────────────────

type EmbeddingEntry = {
  vector: number[];      // 768-dim from Gemini
  updatedAt: string;     // matches note's updatedAt for staleness check
};

type EmbeddingIndex = {
  version: 1;
  method: "gemini" | "tfidf";
  documents: Record<string, EmbeddingEntry>;
};

// ── Config ─────────────────────────────────────────────────────────────────

const INDEX_FILE = resolve(dirs.workspace, "notes", ".embeddings.json");
const GEMINI_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";

function getApiKey(): string {
  return process.env.TALON_GEMINI_API_KEY || "";
}

let index: EmbeddingIndex | null = null;
let dirty = false;

// ── Gemini API ─────────────────────────────────────────────────────────────

async function getGeminiEmbedding(text: string): Promise<number[] | null> {
  const key = getApiKey();
  if (!key) return null;
  try {
    const resp = await fetch(`${GEMINI_EMBED_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/gemini-embedding-001",
        content: { parts: [{ text }] },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? null;
  } catch {
    return null;
  }
}

// Batch embeddings (more efficient)
async function getGeminiEmbeddingsBatch(texts: string[]): Promise<(number[] | null)[]> {
  const key = getApiKey();
  if (!key || texts.length === 0) return texts.map(() => null);
  try {
    const batchUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${key}`;
    const resp = await fetch(batchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: "models/gemini-embedding-001",
          content: { parts: [{ text }] },
        })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return texts.map(() => null);
    const data = await resp.json() as { embeddings?: Array<{ values?: number[] }> };
    return (data.embeddings ?? []).map(e => e.values ?? null);
  } catch {
    return texts.map(() => null);
  }
}

// ── TF-IDF Fallback ────────────────────────────────────────────────────────

const STOP_WORDS = new Set(["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","could","should","may","might","shall","can","need","dare","ought","used","to","of","in","for","on","with","at","by","from","as","into","through","during","before","after","above","below","between","out","off","over","under","again","further","then","once","here","there","when","where","why","how","all","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","just","because","but","and","or","if","while","about","up","it","its","this","that","these","those","i","me","my","we","our","you","your","he","him","his","she","her","they","them","their","what","which","who","whom"]);

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function tfidfSearch(queryText: string, documents: Record<string, string>, limit: number): Array<{ key: string; score: number }> {
  const queryTokens = tokenize(queryText);
  if (queryTokens.length === 0) return [];

  // Build document token maps
  const docTokens = new Map<string, string[]>();
  for (const [key, content] of Object.entries(documents)) {
    docTokens.set(key, tokenize(content));
  }

  // Compute IDF
  const N = docTokens.size;
  const df = new Map<string, number>();
  for (const tokens of docTokens.values()) {
    const unique = new Set(tokens);
    for (const t of unique) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // Score each document
  const scores: Array<{ key: string; score: number }> = [];
  for (const [key, tokens] of docTokens) {
    let score = 0;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    for (const qt of queryTokens) {
      const termTf = (tf.get(qt) ?? 0) / Math.max(tokens.length, 1);
      const termIdf = Math.log(1 + N / (1 + (df.get(qt) ?? 0)));
      score += termTf * termIdf;
    }
    if (score > 0) scores.push({ key, score });
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function loadEmbeddingIndex(): void {
  try {
    const raw = readFileSync(INDEX_FILE, "utf-8");
    index = JSON.parse(raw);
  } catch {
    index = { version: 1, method: getApiKey() ? "gemini" : "tfidf", documents: {} };
  }
}

export function flushEmbeddingIndex(): void {
  if (!index || !dirty) return;
  mkdirSync(dirname(INDEX_FILE), { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(index));
  dirty = false;
}

/** Index a note after save. Async because it may call Gemini API. */
export async function indexNote(key: string, content: string, tags: string[]): Promise<void> {
  if (!index) loadEmbeddingIndex();

  const fullText = `${key} ${tags.join(" ")} ${content}`;
  const vector = await getGeminiEmbedding(fullText);

  if (vector) {
    index!.documents[key] = { vector, updatedAt: new Date().toISOString() };
    index!.method = "gemini";
  }
  // If Gemini fails, no vector stored — will use TF-IDF fallback at search time
  dirty = true;
}

/** Remove note from index after delete. */
export function removeNoteFromIndex(key: string): void {
  if (!index) return;
  delete index.documents[key];
  dirty = true;
}

/** Search notes by semantic similarity. Falls back to TF-IDF. */
export async function searchByEmbedding(
  query: string,
  noteContents: Record<string, string>, // key -> full content
  limit: number = 20,
): Promise<Array<{ key: string; score: number; method: string }>> {
  if (!index) loadEmbeddingIndex();

  // Try embedding search if we have vectors
  const hasVectors = Object.keys(index!.documents).length > 0;

  if (hasVectors && getApiKey()) {
    const queryVector = await getGeminiEmbedding(query);
    if (queryVector) {
      const results: Array<{ key: string; score: number; method: string }> = [];
      for (const [key, entry] of Object.entries(index!.documents)) {
        if (!noteContents[key]) continue; // note was deleted
        const score = cosineSimilarity(queryVector, entry.vector);
        if (score > 0.1) results.push({ key, score, method: "embedding" });
      }
      // Also include notes that don't have embeddings yet (via text match)
      const unindexed = Object.keys(noteContents).filter(k => !index!.documents[k]);
      if (unindexed.length > 0) {
        const unindexedContents: Record<string, string> = {};
        for (const k of unindexed) unindexedContents[k] = noteContents[k];
        const tfidfResults = tfidfSearch(query, unindexedContents, limit);
        for (const r of tfidfResults) results.push({ ...r, method: "tfidf-fallback" });
      }
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }
  }

  // Full TF-IDF fallback
  const tfidfResults = tfidfSearch(query, noteContents, limit);
  return tfidfResults.map(r => ({ ...r, method: "tfidf" }));
}

/** Reindex all notes (batch — call on first load or migration). */
export async function reindexAll(noteContents: Record<string, string>): Promise<number> {
  if (!index) loadEmbeddingIndex();

  const keys = Object.keys(noteContents);
  if (keys.length === 0) return 0;

  // Batch embed via Gemini
  const texts = keys.map(k => `${k} ${noteContents[k]}`);
  const vectors = await getGeminiEmbeddingsBatch(texts);

  let indexed = 0;
  for (let i = 0; i < keys.length; i++) {
    if (vectors[i]) {
      index!.documents[keys[i]] = { vector: vectors[i]!, updatedAt: new Date().toISOString() };
      indexed++;
    }
  }

  if (indexed > 0) {
    index!.method = "gemini";
    dirty = true;
    flushEmbeddingIndex();
  }

  return indexed;
}
