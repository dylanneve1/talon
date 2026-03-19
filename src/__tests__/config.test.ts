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
    it("exits gracefully on first run with no config", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      mockFs(null); // no config file exists

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });

    it("throws when config exists but botToken is empty", async () => {
      mockFs({ botToken: "" });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("Missing bot token");
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

    it("loads Teams frontend config", async () => {
      mockFs({
        frontend: "teams",
        teams: { clientId: "app-id", clientSecret: "secret", tenantId: "tenant-id" },
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("teams");
      expect(config.teams?.clientId).toBe("app-id");
      expect(config.teams?.clientSecret).toBe("secret");
      expect(config.teams?.tenantId).toBe("tenant-id");
    });

    it("throws when Teams frontend is missing credentials", async () => {
      mockFs({ frontend: "teams" });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("teams.clientId");
    });

    it("throws when Teams frontend has partial credentials", async () => {
      mockFs({ frontend: "teams", teams: { clientId: "id" } });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("teams.clientSecret");
    });

    it("defaults frontend to telegram", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("telegram");
    });

    it("allows terminal frontend without botToken", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("terminal");
    });

    it("Teams config defaults port to 3978", async () => {
      mockFs({
        frontend: "teams",
        teams: { clientId: "id", clientSecret: "secret", tenantId: "tenant" },
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.teams?.port).toBe(3978);
    });
  });

  describe("system prompt", () => {
    it("builds system prompt from prompt files", async () => {
      mockFs(
        { botToken: "test-token" },
        { "soul.md": "I am Talon.", "default.md": "Be helpful." },
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
