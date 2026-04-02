import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockFs(
    configJson: Record<string, unknown> | null,
    promptFiles: Record<string, string> = {},
    workspaceEntries?: { name: string; isDir: boolean; size?: number; children?: { name: string; size: number }[] }[],
  ) {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((path: string) => {
        if (path.includes("config.json") || path.includes("talon.json")) return configJson !== null;
        // .talon directory checks (root, data)
        if (path.endsWith(".talon") || path.endsWith("/data")) return true;
        // workspace directory check
        if (path.endsWith("workspace") && workspaceEntries !== undefined) return true;
        if (typeof path === "string") {
          for (const key of Object.keys(promptFiles)) {
            if (path.includes(key)) return true;
          }
        }
        return false;
      }),
      readFileSync: vi.fn((path: string) => {
        if (path.includes("config.json") || path.includes("talon.json")) return JSON.stringify(configJson ?? {});
        for (const [key, val] of Object.entries(promptFiles)) {
          if (path.includes(key)) return val;
        }
        return "";
      }),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn((dir: string) => {
        if (!workspaceEntries) return [];
        // If this is a subdirectory, find its children
        for (const entry of workspaceEntries) {
          if (entry.isDir && dir.endsWith(entry.name) && entry.children) {
            return entry.children.map((c) => ({
              name: c.name,
              isDirectory: () => false,
              isFile: () => true,
            }));
          }
        }
        // Top-level workspace dir
        if (dir.endsWith("workspace")) {
          return workspaceEntries.map((e) => ({
            name: e.name,
            isDirectory: () => e.isDir,
            isFile: () => !e.isDir,
          }));
        }
        return [];
      }),
      statSync: vi.fn((filePath: string) => {
        // Find matching file in workspace entries
        if (workspaceEntries) {
          for (const entry of workspaceEntries) {
            if (!entry.isDir && filePath.endsWith(entry.name)) {
              return { size: entry.size ?? 100 };
            }
            if (entry.isDir && entry.children) {
              for (const child of entry.children) {
                if (filePath.endsWith(child.name)) {
                  return { size: child.size };
                }
              }
            }
          }
        }
        return { size: 0 };
      }),
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

    it("accepts frontend as an array", async () => {
      mockFs({ frontend: ["telegram", "terminal"], botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(Array.isArray(config.frontend)).toBe(true);
      expect(config.frontend).toEqual(["telegram", "terminal"]);
    });

    it("throws when frontend array includes telegram without botToken", async () => {
      mockFs({ frontend: ["telegram", "terminal"] });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("botToken");
    });

    it("parses plugins array in config", async () => {
      mockFs({
        frontend: "terminal",
        plugins: [
          { path: "./plugins/my-plugin", config: { key: "value" } },
          { path: "./plugins/another" },
        ],
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.plugins).toHaveLength(2);
      expect(config.plugins[0].path).toBe("./plugins/my-plugin");
      expect(config.plugins[0].config).toEqual({ key: "value" });
      expect(config.plugins[1].path).toBe("./plugins/another");
      expect(config.plugins[1].config).toBeUndefined();
    });

    it("defaults plugins to empty array", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.plugins).toEqual([]);
    });

    it("creates config file when talon.json does not exist", async () => {
      const writeFileAtomic = await import("write-file-atomic");
      mockFs(null);

      const { loadConfig } = await import("../util/config.js");
      // loadConfig will call ensureConfigFile which writes defaults, then reads (but file won't exist so reads empty)
      // Since no botToken and default frontend is telegram, it will throw
      expect(() => loadConfig()).toThrow("botToken");
      expect(writeFileAtomic.default.sync).toHaveBeenCalled();
    });

    it("sets workspace to resolved workspace path", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.workspace).toContain("workspace");
    });

    it("loads config with terminal-only frontend array (no token needed)", async () => {
      mockFs({ frontend: ["terminal"] });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toEqual(["terminal"]);
    });
  });

  describe("system prompt", () => {
    it("builds system prompt from prompt files", async () => {
      mockFs(
        { botToken: "test-token" },
        { "identity.md": "I am Talon.", "base.md": "Be helpful." },
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

    it("loads terminal.md prompt for terminal frontend", async () => {
      mockFs(
        { frontend: "terminal" },
        { "terminal.md": "You are running in terminal mode." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("You are running in terminal mode.");
    });

    it("loads telegram.md prompt for telegram frontend", async () => {
      mockFs(
        { botToken: "test-token", frontend: "telegram" },
        { "telegram.md": "You are a Telegram bot." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("You are a Telegram bot.");
    });

    it("uses default fallback when no base.md or custom.md exist", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("You are a sharp and helpful AI assistant.");
    });

    it("custom.md overrides base.md", async () => {
      mockFs(
        { frontend: "terminal" },
        { "custom.md": "Custom prompt override.", "base.md": "Default base prompt." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("Custom prompt override.");
      expect(config.systemPrompt).not.toContain("Default base prompt.");
    });

    it("loads identity.md as the first section", async () => {
      mockFs(
        { frontend: "terminal" },
        { "identity.md": "Identity section.", "base.md": "Base instructions." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      // identity.md should come before base.md in the prompt
      const identityIdx = config.systemPrompt.indexOf("Identity section.");
      const baseIdx = config.systemPrompt.indexOf("Base instructions.");
      expect(identityIdx).toBeGreaterThanOrEqual(0);
      expect(baseIdx).toBeGreaterThan(identityIdx);
    });

    it("includes memory.md in persistent memory section", async () => {
      mockFs(
        { frontend: "terminal" },
        { "memory.md": "User prefers dark mode." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("Persistent Memory");
      expect(config.systemPrompt).toContain("User prefers dark mode.");
    });

    it("includes workspace file listing when files exist", async () => {
      mockFs(
        { frontend: "terminal" },
        {},
        [
          { name: "notes.txt", isDir: false, size: 512 },
          { name: "data.csv", isDir: false, size: 2048 },
        ],
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("notes.txt");
      expect(config.systemPrompt).toContain("512B");
      expect(config.systemPrompt).toContain("data.csv");
      expect(config.systemPrompt).toContain("2KB");
    });

    it("skips hidden files and node_modules in workspace listing", async () => {
      mockFs(
        { frontend: "terminal" },
        {},
        [
          { name: ".hidden", isDir: false, size: 100 },
          { name: "node_modules", isDir: true },
          { name: "talon.log", isDir: false, size: 500 },
          { name: "visible.txt", isDir: false, size: 200 },
        ],
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("visible.txt");
      expect(config.systemPrompt).not.toContain(".hidden");
      expect(config.systemPrompt).not.toContain("node_modules");
      expect(config.systemPrompt).not.toContain("talon.log");
    });

    it("shows subdirectory summary when it has more than 8 files", async () => {
      // Create a subdirectory with > 8 children
      const manyChildren = [];
      for (let i = 0; i < 10; i++) {
        manyChildren.push({ name: `file${i}.txt`, size: 100 });
      }
      mockFs(
        { frontend: "terminal" },
        {},
        [
          { name: "bigdir", isDir: true, children: manyChildren },
        ],
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("bigdir/ (10 files)");
    });

    it("lists subdirectory files when 8 or fewer", async () => {
      mockFs(
        { frontend: "terminal" },
        {},
        [
          {
            name: "smalldir",
            isDir: true,
            children: [
              { name: "a.txt", size: 50 },
              { name: "b.txt", size: 75 },
            ],
          },
        ],
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("smalldir/a.txt");
      expect(config.systemPrompt).toContain("smalldir/b.txt");
    });
  });

  describe("getFrontends", () => {
    it("returns array when frontend is a single string", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig, getFrontends } = await import("../util/config.js");
      const config = loadConfig();
      const frontends = getFrontends(config);
      expect(frontends).toEqual(["terminal"]);
    });

    it("returns array as-is when frontend is already an array", async () => {
      mockFs({ frontend: ["telegram", "terminal"], botToken: "test-token" });

      const { loadConfig, getFrontends } = await import("../util/config.js");
      const config = loadConfig();
      const frontends = getFrontends(config);
      expect(frontends).toEqual(["telegram", "terminal"]);
    });
  });

  describe("rebuildSystemPrompt", () => {
    it("does nothing when pluginAdditions is empty", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig, rebuildSystemPrompt } = await import("../util/config.js");
      const config = loadConfig();
      const originalPrompt = config.systemPrompt;
      rebuildSystemPrompt(config, []);
      expect(config.systemPrompt).toBe(originalPrompt);
    });

    it("appends plugin prompt additions to system prompt", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig, rebuildSystemPrompt } = await import("../util/config.js");
      const config = loadConfig();
      rebuildSystemPrompt(config, [
        "## Plugin A\nPlugin A instructions.",
        "## Plugin B\nPlugin B instructions.",
      ]);
      expect(config.systemPrompt).toContain("Plugin A instructions.");
      expect(config.systemPrompt).toContain("Plugin B instructions.");
    });

    it("rebuilds prompt with correct frontend from array config", async () => {
      mockFs(
        { frontend: ["terminal", "telegram"], botToken: "test-token" },
        { "terminal.md": "Terminal-specific prompt." },
      );

      const { loadConfig, rebuildSystemPrompt } = await import("../util/config.js");
      const config = loadConfig();
      rebuildSystemPrompt(config, ["## Test Plugin\nTest addition."]);
      // Should use terminal (first in array) as the active frontend
      expect(config.systemPrompt).toContain("Terminal-specific prompt.");
      expect(config.systemPrompt).toContain("Test addition.");
    });

    it("rebuilds prompt with single string frontend", async () => {
      mockFs(
        { frontend: "terminal" },
        { "terminal.md": "Terminal mode active." },
      );

      const { loadConfig, rebuildSystemPrompt } = await import("../util/config.js");
      const config = loadConfig();
      rebuildSystemPrompt(config, ["## My Plugin\nDo special things."]);
      expect(config.systemPrompt).toContain("Terminal mode active.");
      expect(config.systemPrompt).toContain("Do special things.");
    });
  });

  describe("zod validation boundaries", () => {
    it("rejects concurrency above max 20", async () => {
      mockFs({ frontend: "terminal", concurrency: 25 });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow();
    });

    it("rejects concurrency below min 1", async () => {
      mockFs({ frontend: "terminal", concurrency: 0 });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow();
    });

    it("rejects maxMessageLength below min 100", async () => {
      mockFs({ frontend: "terminal", maxMessageLength: 50 });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow();
    });

    it("default model is exactly claude-sonnet-4-6", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.model).toBe("claude-sonnet-4-6");
    });

    it("default pulse is exactly true", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.pulse).toBe(true);
    });
  });

  describe("loadConfigFile edge cases", () => {
    it("handles corrupt talon.json gracefully", async () => {
      // Simulate a corrupt JSON by having readFileSync throw
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn((path: string) => {
          if (path.includes("config.json") || path.includes("talon.json")) return true;
          if (path.endsWith(".talon") || path.endsWith("/data")) return true;
          return false;
        }),
        readFileSync: vi.fn((path: string) => {
          if (path.includes("config.json") || path.includes("talon.json")) throw new Error("corrupt file");
          return "";
        }),
        mkdirSync: vi.fn(),
        readdirSync: vi.fn(() => []),
        statSync: vi.fn(() => ({ size: 0 })),
      }));

      const { loadConfig } = await import("../util/config.js");
      // With corrupt config, it falls back to empty config => default frontend=telegram => no botToken => throws
      expect(() => loadConfig()).toThrow("botToken");
    });
  });
});

describe("loadConfig — teams webhook validation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("throws when teams frontend has no teamsWebhookUrl", async () => {
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((path: string) => {
        if (path.includes("config.json")) return true;
        return false;
      }),
      readFileSync: vi.fn(() => JSON.stringify({
        frontend: "teams",
        // teamsWebhookUrl intentionally omitted
      })),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ size: 0 })),
    }));

    const { loadConfig } = await import("../util/config.js");
    expect(() => loadConfig()).toThrow("teamsWebhookUrl");
  });
});
