/**
 * Sessions persistence — SQLite durability + the one-time legacy JSON
 * import. Real tmpdir files, no fs mocks: durability claims are only
 * worth testing against the real engine.
 *
 * The per-worker TALON_DB_PATH from setup/test-db.ts is overridden
 * here with per-test paths so close/reopen cycles are observable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// The legacy-import path reads files.sessions — point the whole Talon
// root into a per-test tmpdir via paths mock.
let workDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    files: new Proxy(real.files, {
      get(target, prop: string) {
        if (prop === "sessions") return join(workDir, "sessions.json");
        if (prop === "database") return join(workDir, "talon.db");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { getDatabase, closeDatabase } from "../storage/db.js";
import {
  loadSessions,
  flushSessions,
  getSession,
  setSessionId,
  setSessionName,
  incrementTurns,
  recordUsage,
  resetSession,
  getLastBotMessageId,
  setLastBotMessageId,
} from "../storage/sessions.js";

const envBackup = process.env.TALON_DB_PATH;

beforeEach(() => {
  delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  workDir = mkdtempSync(join(tmpdir(), "talon-sessions-persist-"));
  closeDatabase();
  process.env.TALON_DB_PATH = join(workDir, "talon.db");
  loadSessions(); // start each test from an empty cache + fresh db
});

afterEach(() => {
  closeDatabase();
  if (envBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = envBackup;
  rmSync(workDir, { recursive: true, force: true });
});

/** Close, reopen the same file, and re-prime the cache from disk. */
function reopen(): void {
  closeDatabase();
  getDatabase(join(workDir, "talon.db"));
  loadSessions();
}

describe("sessions persistence", () => {
  it("sessions survive a close/reopen cycle", () => {
    setSessionId("persist-chat", "sid-123");
    setSessionName("persist-chat", "My Session");
    incrementTurns("persist-chat");
    setLastBotMessageId("persist-chat", 42);
    recordUsage("persist-chat", {
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 10,
      cacheWrite: 5,
      durationMs: 1500,
      model: "claude-opus-4-6",
      contextTokens: 85000,
      contextWindow: 200000,
      numApiCalls: 3,
      costUsd: 0.25,
    });
    flushSessions();

    reopen();

    const s = getSession("persist-chat");
    expect(s.sessionId).toBe("sid-123");
    expect(s.sessionName).toBe("My Session");
    expect(s.turns).toBe(1);
    expect(s.lastModel).toBe("claude-opus-4-6");
    expect(getLastBotMessageId("persist-chat")).toBe(42);
    expect(s.usage.totalInputTokens).toBe(100);
    expect(s.usage.totalOutputTokens).toBe(50);
    expect(s.usage.totalCacheRead).toBe(10);
    expect(s.usage.totalCacheWrite).toBe(5);
    expect(s.usage.lastPromptTokens).toBe(115);
    expect(s.usage.contextTokens).toBe(85000);
    expect(s.usage.contextWindow).toBe(200000);
    expect(s.usage.numApiCalls).toBe(3);
    expect(s.usage.estimatedCostUsd).toBe(0.25);
    expect(s.usage.totalResponseMs).toBe(1500);
    expect(s.usage.lastResponseMs).toBe(1500);
    expect(s.usage.fastestResponseMs).toBe(1500);
  });

  it("fastestResponseMs Infinity sentinel round-trips through SQLite", () => {
    // A fresh session has fastestResponseMs = Infinity (no timed turn);
    // SQLite stores NULL and the read path restores the sentinel.
    getSession("inf-chat");
    reopen();
    expect(getSession("inf-chat").usage.fastestResponseMs).toBe(Infinity);
  });

  it("resetSession durably removes the row", () => {
    setSessionId("reset-chat", "sid-gone");
    incrementTurns("reset-chat");
    resetSession("reset-chat");

    reopen();

    const s = getSession("reset-chat");
    expect(s.sessionId).toBeUndefined();
    expect(s.turns).toBe(0);
  });

  it("imports a legacy JsonStore envelope and renames the file", () => {
    writeFileSync(
      join(workDir, "sessions.json"),
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 1716540000000,
        data: {
          "legacy-chat": {
            sessionId: "legacy-sid",
            turns: 9,
            lastActive: 1716539000000,
            createdAt: 1716500000000,
            sessionName: "Legacy",
            usage: {
              totalInputTokens: 1234,
              totalOutputTokens: 567,
              totalCacheRead: 89,
              totalCacheWrite: 12,
              lastPromptTokens: 1335,
              estimatedCostUsd: 0.5,
              totalResponseMs: 4000,
              lastResponseMs: 2000,
              // JSON.stringify(Infinity) === "null" — the envelope on
              // disk holds null here.
              fastestResponseMs: null,
            },
          },
        },
      }),
    );

    loadSessions();

    const s = getSession("legacy-chat");
    expect(s.sessionId).toBe("legacy-sid");
    expect(s.turns).toBe(9);
    expect(s.sessionName).toBe("Legacy");
    expect(s.usage.totalInputTokens).toBe(1234);
    expect(s.usage.fastestResponseMs).toBe(Infinity);
    expect(existsSync(join(workDir, "sessions.json"))).toBe(false);
    expect(existsSync(join(workDir, "sessions.json.imported"))).toBe(true);
  });

  it("imports the bare pre-envelope shape", () => {
    writeFileSync(
      join(workDir, "sessions.json"),
      JSON.stringify({
        "bare-chat": {
          sessionId: "bare-sid",
          turns: 2,
          lastActive: 1000,
          createdAt: 1000,
        },
      }),
    );

    loadSessions();

    const s = getSession("bare-chat");
    expect(s.sessionId).toBe("bare-sid");
    expect(s.turns).toBe(2);
    // Missing usage object on legacy records backfills to zeros.
    expect(s.usage.totalInputTokens).toBe(0);
    expect(s.usage.fastestResponseMs).toBe(Infinity);
  });

  it("does not re-import on subsequent loads", () => {
    writeFileSync(
      join(workDir, "sessions.json"),
      JSON.stringify({
        "once-chat": { sessionId: "x", turns: 1, lastActive: 1, createdAt: 1 },
      }),
    );

    loadSessions();
    incrementTurns("once-chat");
    loadSessions();

    // A re-import would clobber the incremented value back to 1.
    expect(getSession("once-chat").turns).toBe(2);
  });

  it("survives a corrupt legacy file without throwing", () => {
    writeFileSync(join(workDir, "sessions.json"), "not json at all!!!");

    expect(() => loadSessions()).not.toThrow();
    // The DB still works after the failed import.
    setSessionId("after-corrupt", "sid-ok");
    reopen();
    expect(getSession("after-corrupt").sessionId).toBe("sid-ok");
  });

  it("skips malformed legacy entries but keeps valid ones", () => {
    writeFileSync(
      join(workDir, "sessions.json"),
      JSON.stringify({
        "good-chat": { sessionId: "ok", turns: 3, lastActive: 1, createdAt: 1 },
        "null-chat": null,
        "array-chat": [1, 2, 3],
        "string-chat": "nope",
      }),
    );

    loadSessions();

    expect(getSession("good-chat").turns).toBe(3);
    expect(getSession("null-chat").turns).toBe(0);
    expect(getSession("array-chat").turns).toBe(0);
  });
});
