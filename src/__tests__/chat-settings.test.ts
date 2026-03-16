import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// Mock log module
vi.mock("../util/log.js", () => ({
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
  setChatPulse,
  setChatPulseInterval,
  getRegisteredPulseChats,
  loadChatSettings,
  resolveModelName,
  EFFORT_LEVELS,
  MODEL_ALIASES,
} = await import("../storage/chat-settings.js");

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

  describe("setChatPulse", () => {
    it("enables pulse for a chat", () => {
      const chatId = "test-pulse-enable";
      setChatPulse(chatId, true);
      expect(getChatSettings(chatId).pulse).toBe(true);
    });

    it("disables pulse for a chat", () => {
      const chatId = "test-pulse-disable";
      setChatPulse(chatId, true);
      setChatPulse(chatId, false);
      expect(getChatSettings(chatId).pulse).toBe(false);
    });

    it("clears pulse when set to undefined", () => {
      const chatId = "test-pulse-clear";
      setChatPulse(chatId, true);
      setChatPulse(chatId, undefined);
      expect(getChatSettings(chatId).pulse).toBeUndefined();
    });
  });

  describe("setChatPulseInterval", () => {
    it("sets pulse interval in milliseconds", () => {
      const chatId = "test-pulse-interval";
      setChatPulseInterval(chatId, 60000);
      expect(getChatSettings(chatId).pulseIntervalMs).toBe(60000);
    });

    it("clears pulse interval when set to undefined", () => {
      const chatId = "test-pulse-interval-clear";
      setChatPulseInterval(chatId, 30000);
      setChatPulseInterval(chatId, undefined);
      expect(getChatSettings(chatId).pulseIntervalMs).toBeUndefined();
    });

    it("updates an existing interval", () => {
      const chatId = "test-pulse-interval-update";
      setChatPulseInterval(chatId, 30000);
      setChatPulseInterval(chatId, 120000);
      expect(getChatSettings(chatId).pulseIntervalMs).toBe(120000);
    });
  });

  describe("getRegisteredPulseChats", () => {
    it("returns chat IDs where pulse is explicitly true", () => {
      const id1 = "pulse-reg-1";
      const id2 = "pulse-reg-2";
      const id3 = "pulse-reg-3";
      setChatPulse(id1, true);
      setChatPulse(id2, false);
      setChatPulse(id3, true);

      const result = getRegisteredPulseChats();
      expect(result).toContain(id1);
      expect(result).toContain(id3);
      expect(result).not.toContain(id2);
    });

    it("does not include chats without pulse setting", () => {
      const id = "pulse-reg-no-setting";
      setChatModel(id, "claude-opus-4-6"); // set something else, not pulse
      const result = getRegisteredPulseChats();
      expect(result).not.toContain(id);
    });
  });

  describe("loadChatSettings (migration)", () => {
    it("migrates maxThinkingTokens=0 to effort=off", () => {
      const mockData = {
        "migrate-1": { maxThinkingTokens: 0 },
      };
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(mockData));
      // Also mock the dir check for save()
      vi.mocked(existsSync).mockReturnValueOnce(true);

      loadChatSettings();

      const settings = getChatSettings("migrate-1");
      expect(settings.effort).toBe("off");
      // maxThinkingTokens should be removed
      expect((settings as Record<string, unknown>).maxThinkingTokens).toBeUndefined();
    });

    it("migrates maxThinkingTokens=1000 to effort=low", () => {
      const mockData = {
        "migrate-2": { maxThinkingTokens: 1000 },
      };
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(mockData));
      vi.mocked(existsSync).mockReturnValueOnce(true);

      loadChatSettings();

      expect(getChatSettings("migrate-2").effort).toBe("low");
    });

    it("migrates maxThinkingTokens=5000 to effort=medium", () => {
      const mockData = {
        "migrate-3": { maxThinkingTokens: 5000 },
      };
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(mockData));
      vi.mocked(existsSync).mockReturnValueOnce(true);

      loadChatSettings();

      expect(getChatSettings("migrate-3").effort).toBe("medium");
    });

    it("migrates maxThinkingTokens=12000 to effort=high", () => {
      const mockData = {
        "migrate-4": { maxThinkingTokens: 12000 },
      };
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(mockData));
      vi.mocked(existsSync).mockReturnValueOnce(true);

      loadChatSettings();

      expect(getChatSettings("migrate-4").effort).toBe("high");
    });

    it("migrates maxThinkingTokens=20000 to effort=max", () => {
      const mockData = {
        "migrate-5": { maxThinkingTokens: 20000 },
      };
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(mockData));
      vi.mocked(existsSync).mockReturnValueOnce(true);

      loadChatSettings();

      expect(getChatSettings("migrate-5").effort).toBe("max");
    });

    it("removes maxThinkingTokens when effort already set", () => {
      const mockData = {
        "migrate-6": { maxThinkingTokens: 5000, effort: "high" },
      };
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify(mockData));
      vi.mocked(existsSync).mockReturnValueOnce(true);

      loadChatSettings();

      const settings = getChatSettings("migrate-6");
      // Should keep existing effort, just clean up old field
      expect(settings.effort).toBe("high");
      expect((settings as Record<string, unknown>).maxThinkingTokens).toBeUndefined();
    });

    it("handles missing store file gracefully", () => {
      vi.mocked(existsSync).mockReturnValueOnce(false);
      expect(() => loadChatSettings()).not.toThrow();
    });

    it("handles corrupt JSON gracefully", () => {
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce("not valid json{{{");
      expect(() => loadChatSettings()).not.toThrow();
    });
  });
});
