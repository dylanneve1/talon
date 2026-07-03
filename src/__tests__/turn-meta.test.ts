/**
 * Turn-meta store tests — SQLite-backed persistence for the per-turn
 * presentation metadata a frontend records (tool calls, duration,
 * tokens).
 *
 * Uses real temp directories rather than mocking `node:fs`: the legacy
 * native-turn-meta.json path resolves against `process.env.HOME`
 * (overridden per test), and the SQLite database lives in the same
 * temp dir via a per-test TALON_DB_PATH, so every test gets a fresh
 * database and the one-shot legacy import is observable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let originalDisableImport: string | undefined;
const dbEnvBackup = process.env.TALON_DB_PATH;
let tempHome: string;
let closeDb: (() => void) | null = null;

/** Absolute path of the legacy JSON sidecar for the overridden HOME. */
function legacyPath(): string {
  return resolve(tempHome, ".talon", "data", "native-turn-meta.json");
}

/**
 * Re-import the store per test so its module-scoped state (the
 * one-shot import flag) and db.ts's lazily-opened handle both pick up
 * the per-test HOME / TALON_DB_PATH.
 */
async function freshStore() {
  const { vi } = await import("vitest");
  vi.resetModules();
  const db = await import("../storage/db.js");
  closeDb = db.closeDatabase;
  return await import("../storage/turn-meta.js");
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  originalDisableImport = process.env.TALON_DISABLE_LEGACY_IMPORT;
  // Off by default in vitest setup; core ops never touch the legacy
  // path, so leaving it enabled is harmless (no file exists) and the
  // legacy-import test overrides it explicitly below.
  tempHome = mkdtempSync(join(tmpdir(), "talon-turnmeta-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.TALON_DB_PATH = join(tempHome, "talon.db");
});

afterEach(() => {
  closeDb?.();
  closeDb = null;
  if (dbEnvBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = dbEnvBackup;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  if (originalDisableImport !== undefined) {
    process.env.TALON_DISABLE_LEGACY_IMPORT = originalDisableImport;
  } else {
    delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  }
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("turn-meta store", () => {
  it("records and reads back a turn's meta", async () => {
    const { recordTurnMeta, getTurnMeta } = await freshStore();
    recordTurnMeta("c1", "100", {
      durationMs: 4200,
      tokensIn: 10,
      tokensOut: 20,
    });
    expect(getTurnMeta("c1", "100")).toEqual({
      durationMs: 4200,
      tokensIn: 10,
      tokensOut: 20,
    });
  });

  it("shallow-merges repeated records for the same message", async () => {
    const { recordTurnMeta, getTurnMeta } = await freshStore();
    recordTurnMeta("c1", "1", { durationMs: 100 });
    recordTurnMeta("c1", "1", { tokensIn: 5 });
    expect(getTurnMeta("c1", "1")).toEqual({ durationMs: 100, tokensIn: 5 });
  });

  it("is null for an unknown chat/message", async () => {
    const { getTurnMeta } = await freshStore();
    expect(getTurnMeta("nope", "1")).toBeNull();
  });

  it("bounds each chat to the newest 500 turns", async () => {
    const { recordTurnMeta, getTurnMeta } = await freshStore();
    for (let i = 1; i <= 505; i++) {
      recordTurnMeta("c1", String(i), { durationMs: i });
    }
    // Oldest ids evicted past the 500 cap; newest survive.
    expect(getTurnMeta("c1", "5")).toBeNull();
    expect(getTurnMeta("c1", "6")).not.toBeNull();
    expect(getTurnMeta("c1", "505")).not.toBeNull();
  });

  it("clears a whole chat", async () => {
    const { recordTurnMeta, getTurnMeta, clearTurnMeta } = await freshStore();
    recordTurnMeta("c1", "1", { durationMs: 1 });
    recordTurnMeta("c2", "1", { durationMs: 1 });
    clearTurnMeta("c1");
    expect(getTurnMeta("c1", "1")).toBeNull();
    // Other chats untouched.
    expect(getTurnMeta("c2", "1")).not.toBeNull();
  });

  it("imports the legacy nested JSON sidecar on first use", async () => {
    // The importer is gated off in the vitest setup; enable it for this
    // suite, which points HOME at a throwaway dir.
    delete process.env.TALON_DISABLE_LEGACY_IMPORT;
    mkdirSync(resolve(tempHome, ".talon", "data"), { recursive: true });
    // Legacy shape: un-enveloped Record<chatId, Record<msgId, meta>>.
    writeFileSync(
      legacyPath(),
      JSON.stringify({
        c1: {
          "1": { durationMs: 111 },
          "2": { durationMs: 222, tokensOut: 9 },
        },
      }),
    );

    const { getTurnMeta } = await freshStore();
    // First read triggers the one-shot import.
    expect(getTurnMeta("c1", "1")).toEqual({ durationMs: 111 });
    expect(getTurnMeta("c1", "2")).toEqual({ durationMs: 222, tokensOut: 9 });
  });
});
