/**
 * Tests for the active-model resolver (`src/core/active-model.ts`).
 *
 * The resolver is the central fix for the "reset-to-default went to a
 * backend-foreign model" bug class. Each test pins one branch of the
 * resolve logic so future regressions surface immediately:
 *
 *   1. Valid per-chat override → returned as-is, source `override-valid`.
 *   2. Invalid override (resolver returns `missing` or non-selectable)
 *      → backend default, source `override-invalid-fallback`.
 *   3. No override, backend has `getDefaultModel` → backend default,
 *      source `backend-default`.
 *   4. No override, backend lacks `getDefaultModel` → `config.model`,
 *      source `config-default`.
 *   5. Backend has no `resolveModel` → override returned verbatim
 *      (no validation).
 *   6. `getDefaultModel` throws → falls through to `config.model`.
 *   7. `resolveModel` throws → falls through to backend default.
 *   8. `getDefaultModel` returns an empty string → treated as
 *      "no default", falls through to `config.model`.
 *   9. `null` backend → returns override (or `config.model` when none).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { QueryBackend, UnifiedModelResolution } from "../core/types.js";
import type { TalonConfig } from "../util/config.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const { resolveActiveModelForChat, getActiveModelForChat } =
  await import("../core/active-model.js");
const { setChatModel } = await import("../storage/chat-settings.js");

function fakeConfig(model = "claude-opus-4-7"): TalonConfig {
  return { model } as unknown as TalonConfig;
}

function exactResolution(
  id: string,
  selectable = true,
): UnifiedModelResolution {
  return {
    kind: "exact",
    model: {
      id,
      displayName: id,
      provider: "test",
      providerName: "Test",
      selectable,
    },
    storedValue: id,
  };
}

function missingResolution(): UnifiedModelResolution {
  return { kind: "missing" };
}

function fakeBackend(opts: {
  resolveModel?: (q: string) => Promise<UnifiedModelResolution>;
  getDefaultModel?: () => Promise<string> | string;
  backendLabel?: string;
}): QueryBackend {
  const be: Partial<QueryBackend> = {
    query: vi.fn().mockResolvedValue({
      text: "",
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  };
  if (opts.resolveModel) be.resolveModel = opts.resolveModel;
  if (opts.getDefaultModel) be.getDefaultModel = opts.getDefaultModel;
  if (opts.backendLabel) be.backendLabel = opts.backendLabel;
  return be as QueryBackend;
}

describe("resolveActiveModelForChat", () => {
  // Use a fresh chat id per case so the in-memory chat-settings store
  // doesn't leak state across tests.
  let chatId = 0;
  const nextChatId = () => `active-model-test-${++chatId}`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the override verbatim when it resolves exact+selectable", async () => {
    const cid = nextChatId();
    setChatModel(cid, "gpt-5.5");
    const be = fakeBackend({
      resolveModel: async () => exactResolution("gpt-5.5"),
      getDefaultModel: () => "gpt-5-codex",
    });
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result).toEqual({ model: "gpt-5.5", source: "override-valid" });
  });

  it("falls through to backend default when override resolves as missing", async () => {
    const cid = nextChatId();
    setChatModel(cid, "claude-opus-4-7");
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => "gpt-5.5",
    });
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result).toEqual({
      model: "gpt-5.5",
      source: "override-invalid-fallback",
    });
  });

  it("falls through to backend default when override is non-selectable", async () => {
    const cid = nextChatId();
    setChatModel(cid, "gpt-5-codex");
    const be = fakeBackend({
      resolveModel: async () =>
        exactResolution("gpt-5-codex", /* selectable */ false),
      getDefaultModel: () => "gpt-5.5",
    });
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result.source).toBe("override-invalid-fallback");
    expect(result.model).toBe("gpt-5.5");
  });

  it("returns backend default when no override is set", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => "gpt-5.5",
    });
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result).toEqual({ model: "gpt-5.5", source: "backend-default" });
  });

  it("returns config.model when no override and no backend default", async () => {
    const cid = nextChatId();
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(
      cid,
      be,
      fakeConfig("claude-opus-4-7"),
    );
    expect(result).toEqual({
      model: "claude-opus-4-7",
      source: "config-default",
    });
  });

  it("trusts the override verbatim when backend has no resolveModel", async () => {
    const cid = nextChatId();
    setChatModel(cid, "weird-model-id");
    const be = fakeBackend({});
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result).toEqual({
      model: "weird-model-id",
      source: "override-valid",
    });
  });

  it("falls through to config.model when getDefaultModel throws", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => {
        throw new Error("boom");
      },
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      fakeConfig("config-fallback"),
    );
    expect(result.model).toBe("config-fallback");
    expect(result.source).toBe("config-default");
  });

  it("falls through to backend default when resolveModel throws", async () => {
    const cid = nextChatId();
    setChatModel(cid, "bad-override");
    const be = fakeBackend({
      resolveModel: async () => {
        throw new Error("network down");
      },
      getDefaultModel: () => "safe-default",
    });
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result.model).toBe("safe-default");
    expect(result.source).toBe("override-invalid-fallback");
  });

  it("treats empty-string backend default as 'no default'", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: () => "",
    });
    const result = await resolveActiveModelForChat(
      cid,
      be,
      fakeConfig("config-default-id"),
    );
    expect(result.model).toBe("config-default-id");
    expect(result.source).toBe("config-default");
  });

  it("falls back to config.model when backend is null", async () => {
    const cid = nextChatId();
    const result = await resolveActiveModelForChat(
      cid,
      null,
      fakeConfig("nullbackend-default"),
    );
    expect(result).toEqual({
      model: "nullbackend-default",
      source: "config-default",
    });
  });

  it("returns override even when backend is null (no validation possible)", async () => {
    const cid = nextChatId();
    setChatModel(cid, "stored-override");
    const result = await resolveActiveModelForChat(
      cid,
      null,
      fakeConfig("global"),
    );
    expect(result.model).toBe("stored-override");
    expect(result.source).toBe("override-valid");
  });

  it("awaits async getDefaultModel implementations", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: async () => missingResolution(),
      getDefaultModel: async () => "async-default",
    });
    const result = await resolveActiveModelForChat(cid, be, fakeConfig());
    expect(result.model).toBe("async-default");
  });

  it("getActiveModelForChat is a thin wrapper returning just the id", async () => {
    const cid = nextChatId();
    setChatModel(cid, "override");
    const be = fakeBackend({
      resolveModel: async () => exactResolution("override"),
    });
    const model = await getActiveModelForChat(cid, be, fakeConfig());
    expect(model).toBe("override");
  });
});
