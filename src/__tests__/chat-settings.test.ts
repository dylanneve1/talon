import { describe, it, expect, vi } from "vitest";

// Mock log module
vi.mock("../log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Mock fs to avoid real filesystem side effects
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const {
  getChatSettings,
  setChatModel,
  setChatEffort,
  resolveModelName,
  EFFORT_LEVELS,
  MODEL_ALIASES,
} = await import("../chat-settings.js");

describe("chat-settings", () => {
  describe("getChatSettings", () => {
    it("returns empty object for unknown chat", () => {
      const settings = getChatSettings("unknown-chat-abc");
      expect(settings).toEqual({});
    });
  });

  describe("setChatModel", () => {
    it("persists model setting", () => {
      const chatId = "test-model-set";
      setChatModel(chatId, "claude-opus-4-6");
      expect(getChatSettings(chatId).model).toBe("claude-opus-4-6");
    });

    it("clears model when set to undefined", () => {
      const chatId = "test-model-clear";
      setChatModel(chatId, "claude-opus-4-6");
      setChatModel(chatId, undefined);
      expect(getChatSettings(chatId).model).toBeUndefined();
    });
  });

  describe("setChatEffort", () => {
    it("persists effort setting", () => {
      const chatId = "test-effort-set";
      setChatEffort(chatId, "high");
      expect(getChatSettings(chatId).effort).toBe("high");
    });

    it("clears effort when set to undefined", () => {
      const chatId = "test-effort-clear";
      setChatEffort(chatId, "max");
      setChatEffort(chatId, undefined);
      expect(getChatSettings(chatId).effort).toBeUndefined();
    });

    it("accepts all valid effort levels", () => {
      for (const level of EFFORT_LEVELS) {
        const chatId = `test-effort-${level}`;
        setChatEffort(chatId, level);
        expect(getChatSettings(chatId).effort).toBe(level);
      }
    });
  });

  describe("resolveModelName", () => {
    it("resolves 'sonnet' to claude-sonnet-4-6", () => {
      expect(resolveModelName("sonnet")).toBe("claude-sonnet-4-6");
    });

    it("resolves 'opus' to claude-opus-4-6", () => {
      expect(resolveModelName("opus")).toBe("claude-opus-4-6");
    });

    it("resolves 'haiku' to claude-haiku-4-5", () => {
      expect(resolveModelName("haiku")).toBe("claude-haiku-4-5");
    });

    it("resolves versioned aliases", () => {
      expect(resolveModelName("sonnet-4.6")).toBe("claude-sonnet-4-6");
      expect(resolveModelName("opus-4.6")).toBe("claude-opus-4-6");
      expect(resolveModelName("haiku-4.5")).toBe("claude-haiku-4-5");
    });

    it("resolves dash-separated aliases", () => {
      expect(resolveModelName("sonnet-4-6")).toBe("claude-sonnet-4-6");
      expect(resolveModelName("opus-4-6")).toBe("claude-opus-4-6");
      expect(resolveModelName("haiku-4-5")).toBe("claude-haiku-4-5");
    });

    it("is case-insensitive", () => {
      expect(resolveModelName("Sonnet")).toBe("claude-sonnet-4-6");
      expect(resolveModelName("OPUS")).toBe("claude-opus-4-6");
    });

    it("trims whitespace", () => {
      expect(resolveModelName("  sonnet  ")).toBe("claude-sonnet-4-6");
    });

    it("passes through unknown model names unchanged", () => {
      expect(resolveModelName("gpt-4")).toBe("gpt-4");
      expect(resolveModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    });
  });

  describe("EFFORT_LEVELS", () => {
    it("contains all valid levels", () => {
      expect(EFFORT_LEVELS).toEqual(["off", "low", "medium", "high", "max"]);
    });

    it("has 5 levels", () => {
      expect(EFFORT_LEVELS).toHaveLength(5);
    });
  });

  describe("MODEL_ALIASES", () => {
    it("contains all expected aliases", () => {
      expect(Object.keys(MODEL_ALIASES).length).toBeGreaterThanOrEqual(9);
      expect(MODEL_ALIASES.sonnet).toBe("claude-sonnet-4-6");
      expect(MODEL_ALIASES.opus).toBe("claude-opus-4-6");
      expect(MODEL_ALIASES.haiku).toBe("claude-haiku-4-5");
    });
  });
});
