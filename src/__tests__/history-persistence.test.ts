/**
 * History persistence — SQLite durability + the one-time legacy JSON
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

// The legacy-import path reads files.history — point the whole Talon
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
        if (prop === "history") return join(workDir, "history.json");
        if (prop === "database") return join(workDir, "talon.db");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { getDatabase, closeDatabase } from "../storage/db.js";
import {
  loadHistory,
  flushHistory,
  pushMessage,
  getRecentHistory,
  searchHistory,
  type HistoryMessage,
} from "../storage/history.js";

const envBackup = process.env.TALON_DB_PATH;

function makeMsg(msgId: number, text = `msg ${msgId}`): HistoryMessage {
  return {
    msgId,
    senderId: 1,
    senderName: "User",
    text,
    timestamp: Date.now() + msgId,
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "talon-history-persist-"));
  closeDatabase();
  process.env.TALON_DB_PATH = join(workDir, "talon.db");
});

afterEach(() => {
  closeDatabase();
  if (envBackup === undefined) delete process.env.TALON_DB_PATH;
  else process.env.TALON_DB_PATH = envBackup;
  rmSync(workDir, { recursive: true, force: true });
});

describe("history persistence", () => {
  it("messages survive a close/reopen cycle", () => {
    pushMessage("persist-chat", makeMsg(1));
    pushMessage("persist-chat", makeMsg(2));
    flushHistory();

    closeDatabase();
    getDatabase(join(workDir, "talon.db"));

    const history = getRecentHistory("persist-chat");
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.msgId)).toEqual([1, 2]);
  });

  it("imports a legacy JsonStore envelope and renames the file", () => {
    writeFileSync(
      join(workDir, "history.json"),
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 1716540000000,
        data: {
          "legacy-chat": [makeMsg(10, "hello from the envelope")],
        },
      }),
    );

    loadHistory();

    const history = getRecentHistory("legacy-chat");
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe("hello from the envelope");
    expect(existsSync(join(workDir, "history.json"))).toBe(false);
    expect(existsSync(join(workDir, "history.json.imported"))).toBe(true);
  });

  it("imports the bare pre-envelope shape", () => {
    writeFileSync(
      join(workDir, "history.json"),
      JSON.stringify({ "bare-chat": [makeMsg(1, "bare shape message")] }),
    );

    loadHistory();

    expect(getRecentHistory("bare-chat")).toHaveLength(1);
  });

  it("does not re-import on subsequent loads", () => {
    writeFileSync(
      join(workDir, "history.json"),
      JSON.stringify({ "once-chat": [makeMsg(1)] }),
    );

    loadHistory();
    loadHistory();

    expect(getRecentHistory("once-chat")).toHaveLength(1);
  });

  it("survives a corrupt legacy file without throwing", () => {
    writeFileSync(join(workDir, "history.json"), "not json at all!!!");

    expect(() => loadHistory()).not.toThrow();
    // The DB still works after the failed import.
    pushMessage("after-corrupt", makeMsg(1));
    expect(getRecentHistory("after-corrupt")).toHaveLength(1);
  });

  it("skips malformed legacy entries but keeps valid ones", () => {
    writeFileSync(
      join(workDir, "history.json"),
      JSON.stringify({
        "mixed-chat": [
          makeMsg(1),
          { notAMessage: true },
          null,
          makeMsg(2),
          { msgId: "wrong-type", text: 42 },
        ],
        "not-an-array": { msgId: 3 },
      }),
    );

    loadHistory();

    const history = getRecentHistory("mixed-chat");
    expect(history.map((m) => m.msgId)).toEqual([1, 2]);
  });

  it("imported messages are immediately FTS-searchable", () => {
    writeFileSync(
      join(workDir, "history.json"),
      JSON.stringify({
        "fts-chat": [
          makeMsg(1, "the quick brown fox"),
          makeMsg(2, "completely unrelated"),
        ],
      }),
    );

    loadHistory();

    const result = searchHistory("fts-chat", "quick fox");
    expect(result).toContain("quick brown fox");
    expect(result).not.toContain("unrelated");
  });
});
