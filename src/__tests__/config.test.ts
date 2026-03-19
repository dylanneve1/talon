import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockFs(configJson: Record<string, unknown> | null, promptFiles: Record<string, string> = {}) {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((path: string) => {
        if (path.includes("talon.json")) return configJson !== null;
        if (typeof path === "string") {
          for (const key of Object.keys(promptFiles)) {
            if (path.includes(key)) return true;
          }
        }
        return false;
      }),
      readFileSync: vi.fn((path: string) => {
        if (path.includes("talon.json")) return JSON.stringify(configJson ?? {});
        for (const [key, val] of Object.entries(promptFiles)) {
          if (path.includes(key)) return val;
        }
        return "";
      }),
      mkdirSync: vi.fn(),
    }));
  }

  describe("loadConfig", () => {
    it("loads config with terminal frontend (no token needed)", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("terminal");
      expect(config.model).toBe("claude-sonnet-4-6");
    });

    it("throws when telegram frontend has no botToken", async () => {
      mockFs({ frontend: "telegram" });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("botToken");
    });

    it("loads config from talon.json", async () => {
      mockFs({ botToken: "test-token-123", model: "claude-opus-4-6" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("test-token-123");
      expect(config.model).toBe("claude-opus-4-6");
    });

    it("applies defaults for missing fields", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.model).toBe("claude-sonnet-4-6");
      expect(config.maxMessageLength).toBe(4000);
      expect(config.concurrency).toBe(1);
      expect(config.pulse).toBe(true);
      expect(config.pulseIntervalMs).toBe(300000);
    });

    it("reads custom maxMessageLength", async () => {
      mockFs({ botToken: "test-token", maxMessageLength: 8000 });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.maxMessageLength).toBe(8000);
    });

    it("defaults concurrency to 1", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.concurrency).toBe(1);
    });

    it("reads adminUserId from config", async () => {
      mockFs({ botToken: "test-token", adminUserId: 352042062 });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.adminUserId).toBe(352042062);
    });

    it("reads apiId and apiHash from config", async () => {
      mockFs({ botToken: "test-token", apiId: 12345, apiHash: "abc123" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.apiId).toBe(12345);
      expect(config.apiHash).toBe("abc123");
    });

    it("reads pulse settings from config", async () => {
      mockFs({ botToken: "test-token", pulse: false, pulseIntervalMs: 600000 });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.pulse).toBe(false);
      expect(config.pulseIntervalMs).toBe(600000);
    });
  });

  describe("system prompt", () => {
    it("builds system prompt from prompt files", async () => {
      mockFs(
        { botToken: "test-token" },
        { "soul.md": "I am Talon.", "base.md": "Be helpful." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("I am Talon.");
      expect(config.systemPrompt).toContain("Be helpful.");
    });

    it("includes current date in system prompt", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      const today = new Date().toISOString().slice(0, 10);
      expect(config.systemPrompt).toContain(today);
    });

    it("includes workspace instructions in system prompt", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("workspace");
      expect(config.systemPrompt).toContain("Cron Jobs");
    });
  });
});
