/**
 * Tests for the note-embeddings system (semantic search + TF-IDF fallback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

// Mock paths so INDEX_FILE points to our tmp dir
const tmpBase = mkdtempSync(resolve(tmpdir(), "talon-embed-test-"));
const mockWorkspace = resolve(tmpBase, "workspace");

vi.mock("../util/paths.js", () => ({
  dirs: {
    root: tmpBase,
    data: resolve(tmpBase, "data"),
    workspace: mockWorkspace,
    uploads: resolve(mockWorkspace, "uploads"),
    logs: resolve(mockWorkspace, "logs"),
    memory: resolve(mockWorkspace, "memory"),
    stickers: resolve(mockWorkspace, "stickers"),
    prompts: resolve(tmpBase, "prompts"),
    traces: resolve(tmpBase, "data", "traces"),
  },
  files: {},
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

const {
  loadEmbeddingIndex,
  flushEmbeddingIndex,
  indexNote,
  removeNoteFromIndex,
  searchByEmbedding,
  reindexAll,
  getEmbeddingStats,
} = await import("../storage/note-embeddings.js");

// ── Helpers ──────────────────────────────────────────────────────────────────

const INDEX_FILE = resolve(mockWorkspace, "notes", ".embeddings.json");

function resetIndex() {
  // Force module to reload index on next call by clearing internal state
  // We do this by calling loadEmbeddingIndex which re-reads from disk
  try {
    rmSync(INDEX_FILE, { force: true });
  } catch { /* ok */ }
  loadEmbeddingIndex();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("note-embeddings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mkdirSync(resolve(mockWorkspace, "notes"), { recursive: true });
    // Remove old index file
    try { rmSync(INDEX_FILE, { force: true }); } catch { /* ok */ }
    // Reset module state
    loadEmbeddingIndex();
    // No Gemini API key by default
    delete process.env.TALON_GEMINI_API_KEY;
  });

  afterEach(() => {
    delete process.env.TALON_GEMINI_API_KEY;
    vi.restoreAllMocks();
  });

  // ── 1. loadEmbeddingIndex creates empty index when file doesn't exist ────

  it("loadEmbeddingIndex creates empty index when file doesn't exist", () => {
    // Index file doesn't exist (removed in beforeEach)
    loadEmbeddingIndex();
    const stats = getEmbeddingStats();
    expect(stats.documentCount).toBe(0);
    expect(stats.method).toBe("tfidf"); // no API key -> tfidf
  });

  // ── 2. indexNote stores entry gracefully when Gemini API unavailable ──────

  it("indexNote falls back gracefully when Gemini API is unavailable", async () => {
    // No API key set, so Gemini call returns null
    await indexNote("test_key", "some content", ["tag1"]);

    // Should not throw, and index should be dirty but no vector stored
    const stats = getEmbeddingStats();
    // No vector stored since API is unavailable, but the call succeeded
    expect(stats.documentCount).toBe(0);
  });

  it("indexNote stores vector when Gemini API succeeds", async () => {
    process.env.TALON_GEMINI_API_KEY = "fake-key";
    loadEmbeddingIndex(); // reload with API key

    const fakeVector = Array.from({ length: 768 }, (_, i) => i * 0.001);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ embedding: { values: fakeVector } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await indexNote("gemini_note", "content here", ["tag"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const stats = getEmbeddingStats();
    expect(stats.documentCount).toBe(1);
    expect(stats.method).toBe("gemini");

    fetchSpy.mockRestore();
  });

  // ── 3. TF-IDF fallback search works when no embeddings exist ─────────────

  it("TF-IDF fallback search works when no embeddings exist", async () => {
    const noteContents: Record<string, string> = {
      cooking: "pasta recipe tomato basil garlic",
      science: "quantum physics electron photon wave",
      gardening: "roses tulips soil watering fertilizer",
    };

    const results = await searchByEmbedding("quantum physics", noteContents);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].key).toBe("science");
    expect(results[0].method).toBe("tfidf");
    expect(results[0].score).toBeGreaterThan(0);
  });

  // ── 4. removeNoteFromIndex removes entries ───────────────────────────────

  it("removeNoteFromIndex removes entries", async () => {
    process.env.TALON_GEMINI_API_KEY = "fake-key";
    loadEmbeddingIndex();

    const fakeVector = Array.from({ length: 768 }, () => 0.5);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: { values: fakeVector } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await indexNote("to_remove", "some content", []);
    expect(getEmbeddingStats().documentCount).toBe(1);

    removeNoteFromIndex("to_remove");
    expect(getEmbeddingStats().documentCount).toBe(0);

    vi.restoreAllMocks();
  });

  // ── 5. searchByEmbedding with TF-IDF returns relevant results ────────────

  it("searchByEmbedding with TF-IDF returns relevant results for known documents", async () => {
    const noteContents: Record<string, string> = {
      javascript_guide: "javascript typescript nodejs react programming framework",
      python_ml: "python machine learning tensorflow neural network training",
      cooking_italian: "italian pasta carbonara risotto parmesan cheese",
      travel_japan: "tokyo japan sushi temple cherry blossom culture",
      fitness_plan: "workout exercise running cardio strength training",
    };

    // Query about programming
    const progResults = await searchByEmbedding("javascript programming", noteContents);
    expect(progResults.length).toBeGreaterThan(0);
    expect(progResults[0].key).toBe("javascript_guide");
    expect(progResults[0].method).toBe("tfidf");

    // Query about food
    const foodResults = await searchByEmbedding("italian pasta cheese", noteContents);
    expect(foodResults.length).toBeGreaterThan(0);
    expect(foodResults[0].key).toBe("cooking_italian");

    // Query about machine learning
    const mlResults = await searchByEmbedding("machine learning neural", noteContents);
    expect(mlResults.length).toBeGreaterThan(0);
    expect(mlResults[0].key).toBe("python_ml");
  });

  it("searchByEmbedding returns empty array for nonsense query", async () => {
    const noteContents: Record<string, string> = {
      note1: "hello world programming",
    };
    const results = await searchByEmbedding("xyzzyplugh", noteContents);
    expect(results).toEqual([]);
  });

  // ── 6. flushEmbeddingIndex writes to disk ────────────────────────────────

  it("flushEmbeddingIndex writes index to disk", async () => {
    // Mark index dirty by indexing a note (no API key -> no vector, but dirty=true)
    await indexNote("flush_test", "content", []);

    flushEmbeddingIndex();

    expect(existsSync(INDEX_FILE)).toBe(true);
    const raw = JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.method).toBeDefined();
  });

  it("flushEmbeddingIndex is a no-op when not dirty", () => {
    // Fresh index, not dirty
    loadEmbeddingIndex();
    // Remove any existing file
    try { rmSync(INDEX_FILE, { force: true }); } catch { /* ok */ }

    flushEmbeddingIndex();

    // File should NOT be created since index is not dirty
    expect(existsSync(INDEX_FILE)).toBe(false);
  });

  // ── 7. reindexAll processes all provided notes ───────────────────────────

  it("reindexAll processes all provided notes (no API key -> returns 0)", async () => {
    const noteContents: Record<string, string> = {
      note_a: "content a",
      note_b: "content b",
      note_c: "content c",
    };

    const indexed = await reindexAll(noteContents);
    // Without API key, batch embed returns null for all -> 0 indexed
    expect(indexed).toBe(0);
  });

  it("reindexAll indexes all notes when API succeeds", async () => {
    process.env.TALON_GEMINI_API_KEY = "fake-key";
    loadEmbeddingIndex();

    const fakeVector = Array.from({ length: 768 }, () => 0.1);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          embeddings: [
            { values: fakeVector },
            { values: fakeVector },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const noteContents: Record<string, string> = {
      note_x: "content x",
      note_y: "content y",
    };

    const indexed = await reindexAll(noteContents);
    expect(indexed).toBe(2);
    expect(getEmbeddingStats().documentCount).toBe(2);
    expect(getEmbeddingStats().method).toBe("gemini");

    // Should have flushed to disk
    expect(existsSync(INDEX_FILE)).toBe(true);

    vi.restoreAllMocks();
  });

  it("reindexAll returns 0 for empty input", async () => {
    const indexed = await reindexAll({});
    expect(indexed).toBe(0);
  });

  // ── getEmbeddingStats ────────────────────────────────────────────────────

  it("getEmbeddingStats returns correct stats", () => {
    const stats = getEmbeddingStats();
    expect(stats).toHaveProperty("method");
    expect(stats).toHaveProperty("documentCount");
    expect(stats).toHaveProperty("hasApiKey");
    expect(typeof stats.method).toBe("string");
    expect(typeof stats.documentCount).toBe("number");
    expect(typeof stats.hasApiKey).toBe("boolean");
  });

  it("getEmbeddingStats reflects API key presence", () => {
    expect(getEmbeddingStats().hasApiKey).toBe(false);

    process.env.TALON_GEMINI_API_KEY = "test-key";
    expect(getEmbeddingStats().hasApiKey).toBe(true);

    delete process.env.TALON_GEMINI_API_KEY;
    expect(getEmbeddingStats().hasApiKey).toBe(false);
  });
});
