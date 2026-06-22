/**
 * Unit tests for src/memory/temporal.ts — updateKgFact() wrapper.
 *
 * All tests use mock implementations of KgClient and PalaceClient so no live
 * MemPalace MCP server is required.
 */

import { describe, it, expect } from "vitest";
import {
  updateKgFact,
  formatHistoryEntry,
  type KgClient,
  type KgTriple,
  type PalaceClient,
} from "../memory/temporal.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKgClient(currentTriple?: KgTriple): KgClient & {
  queries: string[];
  invalidations: string[];
  additions: Array<{
    subject: string;
    predicate: string;
    object: string;
    validFrom?: string;
  }>;
} {
  const queries: string[] = [];
  const invalidations: string[] = [];
  const additions: Array<{
    subject: string;
    predicate: string;
    object: string;
    validFrom?: string;
  }> = [];

  return {
    queries,
    invalidations,
    additions,
    async query(subject, predicate) {
      queries.push(`${subject}/${predicate}`);
      return currentTriple;
    },
    async invalidate(subject, predicate) {
      invalidations.push(`${subject}/${predicate}`);
    },
    async add(subject, predicate, object, validFrom) {
      additions.push({ subject, predicate, object, validFrom });
    },
  };
}

function makePalaceClient(): PalaceClient & {
  appended: Array<{ room: string; label: string; content: string }>;
} {
  const appended: Array<{ room: string; label: string; content: string }> = [];
  return {
    appended,
    async appendToHistoryDrawer(room, label, content) {
      appended.push({ room, label, content });
    },
  };
}

const FIXED_TS = "2026-06-22T08:00:00.000Z";

// ── formatHistoryEntry ────────────────────────────────────────────────────────

describe("formatHistoryEntry", () => {
  it("formats a history entry with date-only timestamps", () => {
    const entry = formatHistoryEntry(
      "marrow",
      "current_release",
      "v1.6.0",
      "2026-06-01T00:00:00.000Z",
      "2026-06-22T08:00:00.000Z",
    );
    expect(entry).toBe(
      "- [2026-06-01 → 2026-06-22] marrow/current_release: v1.6.0",
    );
  });

  it("slices ISO dates to YYYY-MM-DD only", () => {
    const entry = formatHistoryEntry(
      "a",
      "b",
      "val",
      "2026-01-15T12:30:00Z",
      "2026-12-31T23:59:59Z",
    );
    expect(entry).toContain("[2026-01-15 → 2026-12-31]");
  });

  it("handles 'unknown' as the valid_from value", () => {
    const entry = formatHistoryEntry(
      "x",
      "y",
      "z",
      "unknown",
      "2026-06-22T00:00:00Z",
    );
    expect(entry).toContain("[unknown → 2026-06-22]");
  });
});

// ── updateKgFact — no existing triple ────────────────────────────────────────

describe("updateKgFact — no existing triple", () => {
  it("adds the new triple without invalidating anything", async () => {
    const kg = makeKgClient(undefined);
    await updateKgFact("talon", "heartbeat_model", "claude-opus-4-7", {
      kgClient: kg,
      timestamp: FIXED_TS,
    });

    expect(kg.invalidations).toHaveLength(0);
    expect(kg.additions).toHaveLength(1);
    expect(kg.additions[0]).toMatchObject({
      subject: "talon",
      predicate: "heartbeat_model",
      object: "claude-opus-4-7",
      validFrom: FIXED_TS,
    });
  });

  it("does not touch the palace client when there is no old value", async () => {
    const kg = makeKgClient(undefined);
    const palace = makePalaceClient();
    await updateKgFact("talon", "heartbeat_model", "claude-opus-4-7", {
      kgClient: kg,
      palaceClient: palace,
      historyRoom: "technical/talon",
      timestamp: FIXED_TS,
    });

    expect(palace.appended).toHaveLength(0);
  });
});

// ── updateKgFact — existing triple ───────────────────────────────────────────

describe("updateKgFact — existing triple", () => {
  const existing: KgTriple = {
    subject: "marrow",
    predicate: "current_release",
    object: "v1.6.0",
    valid_from: "2026-06-21T04:27:00.000Z",
    current: true,
  };

  it("invalidates the old triple and adds the new one", async () => {
    const kg = makeKgClient(existing);
    await updateKgFact("marrow", "current_release", "v1.7.0", {
      kgClient: kg,
      timestamp: FIXED_TS,
    });

    expect(kg.invalidations).toEqual(["marrow/current_release"]);
    expect(kg.additions).toHaveLength(1);
    expect(kg.additions[0]).toMatchObject({
      subject: "marrow",
      predicate: "current_release",
      object: "v1.7.0",
      validFrom: FIXED_TS,
    });
  });

  it("archives the old value to the palace history drawer", async () => {
    const kg = makeKgClient(existing);
    const palace = makePalaceClient();
    await updateKgFact("marrow", "current_release", "v1.7.0", {
      kgClient: kg,
      palaceClient: palace,
      historyRoom: "projects/marrow",
      timestamp: FIXED_TS,
    });

    expect(palace.appended).toHaveLength(1);
    expect(palace.appended[0].room).toBe("projects/marrow");
    expect(palace.appended[0].label).toBe("marrow/current_release-history");
    expect(palace.appended[0].content).toContain("v1.6.0");
    expect(palace.appended[0].content).toContain("2026-06-21");
    expect(palace.appended[0].content).toContain("2026-06-22");
  });

  it("skips history archiving when palaceClient is not provided", async () => {
    const kg = makeKgClient(existing);
    // No palaceClient — should still invalidate + add without error
    await updateKgFact("marrow", "current_release", "v1.7.0", {
      kgClient: kg,
      timestamp: FIXED_TS,
    });

    expect(kg.invalidations).toHaveLength(1);
    expect(kg.additions).toHaveLength(1);
  });

  it("skips history archiving when historyRoom is not provided", async () => {
    const kg = makeKgClient(existing);
    const palace = makePalaceClient();
    // palaceClient provided but no historyRoom — history should be skipped
    await updateKgFact("marrow", "current_release", "v1.7.0", {
      kgClient: kg,
      palaceClient: palace,
      // historyRoom deliberately omitted
      timestamp: FIXED_TS,
    });

    expect(palace.appended).toHaveLength(0);
  });
});

// ── updateKgFact — no-op on same value ───────────────────────────────────────

describe("updateKgFact — no-op on same value", () => {
  it("returns early without any KG mutations when value is unchanged", async () => {
    const existing: KgTriple = {
      subject: "marrow",
      predicate: "current_release",
      object: "v1.7.0",
      valid_from: "2026-06-22T04:27:00.000Z",
      current: true,
    };
    const kg = makeKgClient(existing);
    const palace = makePalaceClient();

    await updateKgFact("marrow", "current_release", "v1.7.0", {
      kgClient: kg,
      palaceClient: palace,
      historyRoom: "projects/marrow",
      timestamp: FIXED_TS,
    });

    expect(kg.invalidations).toHaveLength(0);
    expect(kg.additions).toHaveLength(0);
    expect(palace.appended).toHaveLength(0);
  });
});

// ── updateKgFact — uses caller-supplied timestamp ────────────────────────────

describe("updateKgFact — timestamp handling", () => {
  it("uses the provided timestamp as validFrom", async () => {
    const kg = makeKgClient(undefined);
    const ts = "2026-01-01T00:00:00.000Z";
    await updateKgFact("talon", "version", "v2.0.0", {
      kgClient: kg,
      timestamp: ts,
    });

    expect(kg.additions[0].validFrom).toBe(ts);
  });

  it("falls back to Date.now() when no timestamp provided", async () => {
    const kg = makeKgClient(undefined);
    const before = new Date().toISOString();
    await updateKgFact("talon", "version", "v2.0.0", { kgClient: kg });
    const after = new Date().toISOString();

    const usedTs = kg.additions[0].validFrom!;
    expect(usedTs >= before).toBe(true);
    expect(usedTs <= after).toBe(true);
  });
});
