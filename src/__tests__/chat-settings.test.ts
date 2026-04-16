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

// Mock write-file-atomic to prevent writes to the real production file
vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
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
} = await import("../storage/chat-settings.js");

// Register Claude models (static — no SDK subprocess in tests)
const { registerClaudeModelsStatic, CLAUDE_MODELS_STATIC } =
  await import("../backend/claude-sdk/models.js");
registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);

// convertSdkModels collapses base + 1M variants into a single canonical ID
// per family+version, preferring the 1M variant (and "default" when the SDK
// marks one canonical). So sonnet/sonnet[1m] → "default", opus/opus[1m] →
// "opus[1m]", and plain "haiku" stays.
const SDK_MODEL_IDS = {
  sonnet: "default",
  opus: "opus[1m]",
  haiku: "haiku",
} as const;

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
    it("resolves 'sonnet' to the SDK default model ID", () => {
      expect(resolveModelName("sonnet")).toBe(SDK_MODEL_IDS.sonnet);
    });

    it("resolves 'opus' to the SDK Opus model ID", () => {
      expect(resolveModelName("opus")).toBe(SDK_MODEL_IDS.opus);
    });

    it("resolves 'haiku' to the SDK Haiku model ID", () => {
      expect(resolveModelName("haiku")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("resolves versioned aliases", () => {
      expect(resolveModelName("sonnet-4.6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus-4.6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku-4.5")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("resolves dash-separated aliases", () => {
      expect(resolveModelName("sonnet-4-6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus-4-6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku-4-5")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("is case-insensitive", () => {
      expect(resolveModelName("Sonnet")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("OPUS")).toBe(SDK_MODEL_IDS.opus);
    });

    it("trims whitespace", () => {
      expect(resolveModelName("  sonnet  ")).toBe(SDK_MODEL_IDS.sonnet);
    });

    it("passes through unknown model names unchanged", () => {
      expect(resolveModelName("gpt-4")).toBe("gpt-4");
    });

    it("resolves legacy claude-* aliases to the current SDK IDs", () => {
      expect(resolveModelName("claude-sonnet-4-6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("claude-opus-4-6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("claude-haiku-4-5")).toBe(SDK_MODEL_IDS.haiku);
    });
  });

  describe("resolveModelName — exhaustive alias coverage", () => {
    it("resolves all base aliases correctly", () => {
      expect(resolveModelName("sonnet")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("resolves all dot-separated version aliases", () => {
      expect(resolveModelName("sonnet-4.6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus-4.6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku-4.5")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("resolves all dash-separated version aliases", () => {
      expect(resolveModelName("sonnet-4-6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus-4-6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku-4-5")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("passes through completely unknown model names unchanged", () => {
      expect(resolveModelName("gpt-4")).toBe("gpt-4");
      expect(resolveModelName("llama-3")).toBe("llama-3");
      expect(resolveModelName("mistral-large")).toBe("mistral-large");
    });

    it("maps full claude compatibility aliases to the current SDK IDs", () => {
      expect(resolveModelName("claude-sonnet-4-6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("claude-opus-4-6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("claude-haiku-4-5")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("preserves original casing for unknown models", () => {
      expect(resolveModelName("MyCustomModel")).toBe("MyCustomModel");
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

  describe("model alias resolution (via registry)", () => {
    it("resolves short aliases to SDK model IDs", () => {
      expect(resolveModelName("sonnet")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("resolves versioned aliases", () => {
      expect(resolveModelName("sonnet-4-6")).toBe(SDK_MODEL_IDS.sonnet);
      expect(resolveModelName("opus-4.6")).toBe(SDK_MODEL_IDS.opus);
      expect(resolveModelName("haiku-4.5")).toBe(SDK_MODEL_IDS.haiku);
    });

    it("passes through unknown names unchanged", () => {
      expect(resolveModelName("gpt-4o")).toBe("gpt-4o");
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
      expect(
        (settings as Record<string, unknown>).maxThinkingTokens,
      ).toBeUndefined();
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
      expect(
        (settings as Record<string, unknown>).maxThinkingTokens,
      ).toBeUndefined();
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

describe("chat-settings — setPulseLastCheckMsgId", () => {
  it("sets pulseLastCheckMsgId when msgId is provided", async () => {
    const { setPulseLastCheckMsgId, getChatSettings } =
      await import("../storage/chat-settings.js");
    setPulseLastCheckMsgId("pulse-check-1", 42);
    expect(getChatSettings("pulse-check-1").pulseLastCheckMsgId).toBe(42);
  });

  it("clears pulseLastCheckMsgId when undefined is passed", async () => {
    const { setPulseLastCheckMsgId, getChatSettings } =
      await import("../storage/chat-settings.js");
    setPulseLastCheckMsgId("pulse-check-2", 100);
    setPulseLastCheckMsgId("pulse-check-2", undefined);
    expect(
      getChatSettings("pulse-check-2").pulseLastCheckMsgId,
    ).toBeUndefined();
  });

  it("removes empty settings object after all fields cleared", async () => {
    const { setPulseLastCheckMsgId, getChatSettings } =
      await import("../storage/chat-settings.js");
    // Set only pulseLastCheckMsgId (no model, effort, pulse, pulseIntervalMs)
    setPulseLastCheckMsgId("pulse-cleanup-1", 99);
    setPulseLastCheckMsgId("pulse-cleanup-1", undefined);
    // cleanupEmpty should have removed the settings object
    expect(getChatSettings("pulse-cleanup-1")).toEqual({});
  });
});

describe("chat-settings — migration of has-effort + maxThinkingTokens", () => {
  it("cleans up maxThinkingTokens when effort already set", async () => {
    const { loadChatSettings, getChatSettings } =
      await import("../storage/chat-settings.js");
    const { existsSync, readFileSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValueOnce(true);
    vi.mocked(readFileSync).mockReturnValueOnce(
      JSON.stringify({
        "migrate-has-effort": { effort: "high", maxThinkingTokens: 16000 },
      }),
    );
    loadChatSettings();
    const s = getChatSettings("migrate-has-effort");
    expect(s.effort).toBe("high");
    expect((s as Record<string, unknown>).maxThinkingTokens).toBeUndefined();
  });
});

describe("chat-settings — flushChatSettings", () => {
  it("does not throw when called", async () => {
    const { flushChatSettings, setChatModel } =
      await import("../storage/chat-settings.js");
    // Make dirty first so save() runs
    setChatModel("flush-test", "claude-opus-4-6");
    expect(() => flushChatSettings()).not.toThrow();
  });
});

describe("chat-settings — cleanupEmpty keeps entry when other fields remain (line 115 FALSE branch)", () => {
  it("does not delete entry when effort is still set after clearing model", () => {
    const chatId = `cleanup-keep-entry-${Date.now()}`;
    // Set both model and effort
    setChatModel(chatId, "claude-sonnet-4-6");
    setChatEffort(chatId, "high");
    expect(getChatSettings(chatId).model).toBe("claude-sonnet-4-6");
    expect(getChatSettings(chatId).effort).toBe("high");

    // Clear model only — effort still set → cleanupEmpty condition is FALSE → entry kept
    setChatModel(chatId, undefined);
    expect(getChatSettings(chatId).effort).toBe("high");
    expect(getChatSettings(chatId).model).toBeUndefined();
  });
});

describe("chat-settings — backup recovery on corrupt primary", () => {
  it("loads from backup when primary JSON is corrupt", async () => {
    const { loadChatSettings, getChatSettings } =
      await import("../storage/chat-settings.js");
    vi.mocked(existsSync)
      .mockReturnValueOnce(true) // primary exists
      .mockReturnValueOnce(true); // backup exists
    vi.mocked(readFileSync)
      .mockReturnValueOnce("{ INVALID JSON") // primary corrupt
      .mockReturnValueOnce(
        JSON.stringify({
          "backup-settings-chat": {
            model: "claude-sonnet-4-6",
            effort: "medium",
          },
        }),
      );
    loadChatSettings();
    const s = getChatSettings("backup-settings-chat");
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.effort).toBe("medium");
  });
});
