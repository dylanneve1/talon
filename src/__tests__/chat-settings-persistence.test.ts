/**
 * Chat-settings persistence — SQLite durability + the one-time legacy
 * JSON import and the two intra-data migrations. Real tmpdir files, no
 * fs mocks: durability claims are only worth testing against the real
 * engine.
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

// The legacy-import path reads files.chatSettings — point the whole
// Talon root into a per-test tmpdir via paths mock.
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
        if (prop === "chatSettings") return join(workDir, "chat-settings.json");
        if (prop === "database") return join(workDir, "talon.db");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { getDatabase, closeDatabase } from "../storage/db.js";
import {
  loadChatSettings,
  flushChatSettings,
  getChatSettings,
  getAllChatSettings,
  setChatModel,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  setChatPulse,
  migrateLegacyModelField,
} from "../storage/chat-settings.js";

const envBackup = process.env.TALON_DB_PATH;

beforeEach(() => {
  delete process.env.TALON_DISABLE_LEGACY_IMPORT;
  workDir = mkdtempSync(join(tmpdir(), "talon-settings-persist-"));
  closeDatabase();
  process.env.TALON_DB_PATH = join(workDir, "talon.db");
  loadChatSettings(); // start each test from an empty cache + fresh db
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
  loadChatSettings();
}

describe("chat-settings persistence", () => {
  it("settings survive a close/reopen cycle", () => {
    setChatBackend("persist-chat", "codex");
    setChatModelForBackend("persist-chat", "codex", "gpt-5.5");
    setChatEffort("persist-chat", "high");
    setChatPulse("persist-chat", true);
    flushChatSettings();

    reopen();

    const s = getChatSettings("persist-chat");
    expect(s.backend).toBe("codex");
    expect(s.modelByBackend).toEqual({ codex: "gpt-5.5" });
    expect(s.effort).toBe("high");
    expect(s.pulse).toBe(true);
  });

  it("clearing the last field durably deletes the row", () => {
    setChatEffort("cleanup-chat", "low");
    setChatEffort("cleanup-chat", undefined);

    reopen();

    expect(getChatSettings("cleanup-chat")).toEqual({});
    expect(getAllChatSettings()["cleanup-chat"]).toBeUndefined();
  });

  it("imports a legacy JsonStore envelope and renames the file", () => {
    writeFileSync(
      join(workDir, "chat-settings.json"),
      JSON.stringify({
        schemaVersion: 1,
        savedAt: 1716540000000,
        data: {
          "legacy-chat": { effort: "max", backend: "claude" },
        },
      }),
    );

    loadChatSettings();

    const s = getChatSettings("legacy-chat");
    expect(s.effort).toBe("max");
    expect(s.backend).toBe("claude");
    expect(existsSync(join(workDir, "chat-settings.json"))).toBe(false);
    expect(existsSync(join(workDir, "chat-settings.json.imported"))).toBe(true);
  });

  it("imports the bare pre-envelope shape", () => {
    writeFileSync(
      join(workDir, "chat-settings.json"),
      JSON.stringify({ "bare-chat": { pulse: true, pulseIntervalMs: 60000 } }),
    );

    loadChatSettings();

    const s = getChatSettings("bare-chat");
    expect(s.pulse).toBe(true);
    expect(s.pulseIntervalMs).toBe(60000);
  });

  it("does not re-import on subsequent loads", () => {
    writeFileSync(
      join(workDir, "chat-settings.json"),
      JSON.stringify({ "once-chat": { effort: "low" } }),
    );

    loadChatSettings();
    setChatEffort("once-chat", "high");
    loadChatSettings();

    // A re-import would clobber the updated value back to "low".
    expect(getChatSettings("once-chat").effort).toBe("high");
  });

  it("survives a corrupt legacy file without throwing", () => {
    writeFileSync(join(workDir, "chat-settings.json"), "not json at all!!!");

    expect(() => loadChatSettings()).not.toThrow();
    setChatEffort("after-corrupt", "medium");
    reopen();
    expect(getChatSettings("after-corrupt").effort).toBe("medium");
  });

  it("maxThinkingTokens → effort migration is durable", () => {
    writeFileSync(
      join(workDir, "chat-settings.json"),
      JSON.stringify({
        "tokens-chat": { maxThinkingTokens: 12000 },
      }),
    );

    loadChatSettings();
    reopen();

    const s = getChatSettings("tokens-chat");
    expect(s.effort).toBe("high");
    expect((s as Record<string, unknown>).maxThinkingTokens).toBeUndefined();
  });

  it("legacy model → modelByBackend migration is durable", () => {
    writeFileSync(
      join(workDir, "chat-settings.json"),
      JSON.stringify({
        "model-chat": { model: "claude-opus-4-6" },
        "bound-chat": { model: "gpt-5.5", backend: "codex" },
      }),
    );

    loadChatSettings();
    migrateLegacyModelField("claude", (id) => ["claude", "codex"].includes(id));
    reopen();

    const unbound = getChatSettings("model-chat");
    expect(unbound.model).toBeUndefined();
    expect(unbound.modelByBackend).toEqual({ claude: "claude-opus-4-6" });
    const bound = getChatSettings("bound-chat");
    expect(bound.model).toBeUndefined();
    expect(bound.modelByBackend).toEqual({ codex: "gpt-5.5" });
  });

  it("legacy setChatModel writes survive reopen", () => {
    setChatModel("slot-chat", "some-model");
    reopen();
    expect(getChatSettings("slot-chat").model).toBe("some-model");
  });
});
