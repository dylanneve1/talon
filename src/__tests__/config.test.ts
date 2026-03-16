import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Global mock for write-file-atomic (used by config.ts for talon.json creation)
vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

// Save original env
const originalEnv = { ...process.env };

describe("config", () => {
  beforeEach(() => {
    // Reset all TALON_ env vars before each test
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("TALON_") ||
        key === "TELEGRAM_BOT_TOKEN"
      ) {
        delete process.env[key];
      }
    }
    // Clear module cache so loadConfig re-reads env
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (
        key.startsWith("TALON_") ||
        key === "TELEGRAM_BOT_TOKEN"
      ) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  describe("loadConfig", () => {
    it("exits gracefully on first run with no bot token", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(0);
      exitSpy.mockRestore();
    });

    it("throws when config exists but bot token is empty", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn((path: string) => typeof path === "string" && path.includes("talon.json")),
        readFileSync: vi.fn(() => JSON.stringify({ botToken: "" })),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("Missing bot token");
    });

    it("reads TALON_BOT_TOKEN from env", async () => {
      process.env.TALON_BOT_TOKEN = "test-token-123";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("test-token-123");
    });

    it("falls back to TELEGRAM_BOT_TOKEN", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "fallback-token-456";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("fallback-token-456");
    });

    it("uses default model when TALON_MODEL not set", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.model).toBe("claude-sonnet-4-6");
    });

    it("uses custom model from TALON_MODEL", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";
      process.env.TALON_MODEL = "claude-opus-4-6";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.model).toBe("claude-opus-4-6");
    });

    it("defaults maxMessageLength to 4000", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.maxMessageLength).toBe(4000);
    });

    it("reads custom maxMessageLength from env", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";
      process.env.TALON_MAX_MESSAGE_LENGTH = "8000";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.maxMessageLength).toBe(8000);
    });

    it("defaults concurrency to 1", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      vi.doMock("write-file-atomic", () => ({
        default: { sync: vi.fn() },
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.concurrency).toBe(1);
    });

    it("defaults pulse to true", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      vi.doMock("write-file-atomic", () => ({
        default: { sync: vi.fn() },
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.pulse).toBe(true);
    });

    it("returns a workspace path ending with 'workspace'", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.workspace).toMatch(/workspace$/);
    });

    it("returns a non-empty systemPrompt", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt.length).toBeGreaterThan(0);
    });

    it("uses TALON_SYSTEM_PROMPT when set", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";
      process.env.TALON_SYSTEM_PROMPT = "Custom system prompt for testing.";

      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false),
        readFileSync: vi.fn(() => ""),
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toBe("Custom system prompt for testing.");
    });

    it("loads token from .env file", async () => {
      const envContent = 'TALON_BOT_TOKEN=from-env-file\nTALON_MODEL=claude-opus-4-6\n';
      const existsSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return true;
        return false;
      });
      const readFileSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return envContent;
        return "";
      });

      vi.doMock("node:fs", () => ({
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("from-env-file");
      expect(config.model).toBe("claude-opus-4-6");
    });

    it("strips quotes from .env values", async () => {
      const envContent = 'TALON_BOT_TOKEN="quoted-token"\nTALON_MODEL=\'single-quoted\'';
      const existsSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return true;
        return false;
      });
      const readFileSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return envContent;
        return "";
      });

      vi.doMock("node:fs", () => ({
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("quoted-token");
      expect(config.model).toBe("single-quoted");
    });

    it("skips comments and blank lines in .env", async () => {
      const envContent = '# This is a comment\n\nTALON_BOT_TOKEN=env-token\n# Another comment';
      const existsSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return true;
        return false;
      });
      const readFileSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return envContent;
        return "";
      });

      vi.doMock("node:fs", () => ({
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("env-token");
    });

    it("does not override existing env vars from .env", async () => {
      process.env.TALON_BOT_TOKEN = "already-set";
      const envContent = 'TALON_BOT_TOKEN=from-file';
      const existsSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return true;
        return false;
      });
      const readFileSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return envContent;
        return "";
      });

      vi.doMock("node:fs", () => ({
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("already-set");
    });

    it("skips lines without = sign", async () => {
      const envContent = 'TALON_BOT_TOKEN=valid-token\nINVALID_LINE\n=no_key';
      const existsSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return true;
        return false;
      });
      const readFileSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.endsWith(".env")) return envContent;
        return "";
      });

      vi.doMock("node:fs", () => ({
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.botToken).toBe("valid-token");
    });

    it("reads soul.md prompt file when it exists", async () => {
      process.env.TALON_BOT_TOKEN = "test-token";
      const existsSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.includes("soul.md")) return true;
        return false;
      });
      const readFileSyncMock = vi.fn((path: string) => {
        if (typeof path === "string" && path.includes("soul.md")) return "I am Talon.";
        return "";
      });

      vi.doMock("node:fs", () => ({
        existsSync: existsSyncMock,
        readFileSync: readFileSyncMock,
        mkdirSync: vi.fn(),
      }));

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("I am Talon.");
    });
  });
});
