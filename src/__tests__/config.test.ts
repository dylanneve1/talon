import { describe, it, expect, vi, beforeEach } from "vitest";
// Real fs, bound before any vi.doMock("node:fs") below: package-owned
// system templates (prompts/system/*.md) are part of the code under
// test, so the mock delegates those reads to the real filesystem.
import { readFileSync as realReadFileSync } from "node:fs";
// The prompt embeds the date in the configured timezone (util/time.ts),
// not UTC — computing "today" via toISOString() makes these tests fail
// around midnight in any non-UTC timezone.
import { toYMD } from "../util/time.js";

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const isSystemTemplatePath = (path: string): boolean =>
  /prompts[\\/]system[\\/].*\.md$/.test(path);

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function mockFs(
    configJson: Record<string, unknown> | null,
    promptFiles: Record<string, string> = {},
    workspaceEntries?: {
      name: string;
      isDir: boolean;
      size?: number;
      children?: { name: string; size: number }[];
    }[],
  ) {
    const readdirSync = vi.fn((dir: string) => {
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
    });
    const statSync = vi.fn((filePath: string) => {
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
    });
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((path: string) => {
        if (path.includes("config.json") || path.includes("talon.json"))
          return configJson !== null;
        // .talon directory checks (root, data)
        if (path.endsWith(".talon") || path.endsWith("/data")) return true;
        // workspace directory check
        if (path.endsWith("workspace") && workspaceEntries !== undefined)
          return true;
        if (typeof path === "string") {
          for (const key of Object.keys(promptFiles)) {
            if (path.includes(key)) return true;
          }
        }
        return false;
      }),
      readFileSync: vi.fn((path: string) => {
        if (typeof path === "string" && isSystemTemplatePath(path))
          return realReadFileSync(path, "utf-8");
        if (path.includes("config.json") || path.includes("talon.json"))
          return JSON.stringify(configJson ?? {});
        for (const [key, val] of Object.entries(promptFiles)) {
          if (path.includes(key)) return val;
        }
        return "";
      }),
      mkdirSync: vi.fn(),
      readdirSync,
      statSync,
    }));
    return { readdirSync, statSync };
  }

  describe("loadConfig", () => {
    it("loads config with terminal frontend (no token needed)", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("terminal");
      expect(config.model).toBe("default");
    });

    it("normalizes deprecated desktop frontend aliases to native", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFs({
        frontend: "desktop",
        desktop: { host: "0.0.0.0", port: 19999, token: "bridge-token" },
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.frontend).toBe("native");
      expect(config.native).toEqual({
        host: "0.0.0.0",
        port: 19999,
        token: "bridge-token",
      });
      expect(warn).toHaveBeenCalledWith(
        'Deprecated "desktop" frontend config detected; use "native" instead.',
      );
      warn.mockRestore();
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
      expect(config.model).toBe("default");
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
      const [firstPlugin, secondPlugin] = config.plugins;

      expect("path" in firstPlugin).toBe(true);
      if ("path" in firstPlugin) {
        expect(firstPlugin.path).toBe("./plugins/my-plugin");
        expect(firstPlugin.config).toEqual({ key: "value" });
      }

      expect("path" in secondPlugin).toBe(true);
      if ("path" in secondPlugin) {
        expect(secondPlugin.path).toBe("./plugins/another");
        expect(secondPlugin.config).toBeUndefined();
      }
    });

    it("parses standalone MCP plugins in config", async () => {
      mockFs({
        frontend: "terminal",
        plugins: [
          {
            name: "polymarket",
            command: "node",
            args: ["/tmp/polymarket.js"],
            env: { POLYMARKET_PRIVATE_KEY: "0x123" },
          },
        ],
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();

      expect(config.plugins).toEqual([
        {
          name: "polymarket",
          command: "node",
          args: ["/tmp/polymarket.js"],
          env: { POLYMARKET_PRIVATE_KEY: "0x123" },
        },
      ]);
    });

    it("rejects plugin entries that mix path and standalone MCP fields", async () => {
      mockFs({
        frontend: "terminal",
        plugins: [
          {
            path: "./plugins/extras",
            name: "extras",
            command: "node",
          },
        ],
      });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow("exactly one format");
    });

    it("rejects standalone MCP entries missing required fields", async () => {
      mockFs({
        frontend: "terminal",
        plugins: [{ name: "polymarket" }],
      });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow(
        "MCP plugin entries must include 'command'",
      );
    });

    it("rejects standalone MCP entries with config blocks", async () => {
      mockFs({
        frontend: "terminal",
        plugins: [
          {
            name: "polymarket",
            command: "node",
            config: { market: "crypto" },
          },
        ],
      });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow(
        "MCP plugin entries cannot include 'config'",
      );
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

    it("preserves Playwright endpoint settings from config", async () => {
      mockFs({
        frontend: "terminal",
        playwright: {
          enabled: true,
          browser: "firefox",
          endpoint: "ws://127.0.0.1:9222/devtools/browser/test",
          endpointFile: "/tmp/camoufox-endpoint.txt",
        },
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();

      expect(config.playwright).toEqual({
        enabled: true,
        browser: "firefox",
        headless: true,
        endpoint: "ws://127.0.0.1:9222/devtools/browser/test",
        endpointFile: "/tmp/camoufox-endpoint.txt",
      });
    });

    it("memoryPreRetrieval is absent by default (Phase B ships inert)", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.memoryPreRetrieval).toBeUndefined();
    });

    it("parses memoryPreRetrieval with schema defaults applied", async () => {
      mockFs({
        frontend: "terminal",
        memoryPreRetrieval: { enabled: true },
      });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.memoryPreRetrieval).toEqual({
        enabled: true,
        maxResults: 3,
        maxChars: 3000,
        groupPrivateUserFiltering: true,
      });
    });

    it("rejects out-of-range memoryPreRetrieval values", async () => {
      mockFs({
        frontend: "terminal",
        memoryPreRetrieval: { enabled: true, maxResults: 0 },
      });

      const { loadConfig } = await import("../util/config.js");
      expect(() => loadConfig()).toThrow();
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
      const today = toYMD(new Date());
      expect(config.systemPrompt).toContain(today);
    });

    it("splits the prompt into cache-stable static and volatile dynamic parts", async () => {
      mockFs(
        { botToken: "test-token" },
        {
          "identity.md": "I am Talon.",
          "base.md": "Be helpful.",
          "memory.md": "User prefers dark mode.",
        },
      );

      const { loadConfig, joinSystemPromptParts } =
        await import("../util/config.js");
      const config = loadConfig();

      expect(config.systemPromptParts).toBeDefined();
      const parts = config.systemPromptParts!;

      // Static part: identity, base, memory — the cacheable prefix.
      expect(parts.staticText).toContain("I am Talon.");
      expect(parts.staticText).toContain("Be helpful.");
      expect(parts.staticText).toContain("User prefers dark mode.");
      expect(parts.staticText).toContain("Scheduled jobs (cron)");

      // Volatile content must NOT pollute the static prefix.
      expect(parts.staticText).not.toContain("Daily Memory");
      expect(parts.staticText).not.toContain("Current Workspace Contents");

      // Dynamic part: daily-memory pointer (carries today's date).
      const today = toYMD(new Date());
      expect(parts.dynamicText).toContain("Daily Memory");
      expect(parts.dynamicText).toContain(today);

      // Joined form must equal the single-string prompt other backends use.
      expect(config.systemPrompt).toBe(joinSystemPromptParts(parts));
    });

    it("omits the minute-precision datetime section (cache-buster)", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).not.toContain("Current Date & Time");
      // Time-of-day belongs in per-message tags, not the system prompt.
      const hhmm = new Date().toISOString().slice(11, 16);
      expect(config.systemPromptParts!.staticText).not.toContain(hhmm);
    });

    it("includes workspace instructions in system prompt", async () => {
      mockFs({ botToken: "test-token" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("workspace");
      expect(config.systemPrompt).toContain("Scheduled jobs (cron)");
    });

    it("loads terminal.md prompt for terminal frontend", async () => {
      mockFs(
        { frontend: "terminal" },
        { "terminal.md": "You are running in terminal mode." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain(
        "You are running in terminal mode.",
      );
    });

    it("loads native.md prompt for native frontend", async () => {
      mockFs(
        { frontend: "native" },
        { "native.md": "You are running in native mode." },
      );

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("You are running in native mode.");
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
      expect(config.systemPrompt).toContain(
        "You are a sharp and helpful AI assistant.",
      );
    });

    it("custom.md overrides base.md", async () => {
      mockFs(
        { frontend: "terminal" },
        {
          "custom.md": "Custom prompt override.",
          "base.md": "Default base prompt.",
        },
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

    it("caps oversized memory.md and appends a truncation pointer", async () => {
      const line = "remembered fact about the user\n";
      const bigMemory = line.repeat(600); // ~19k chars > MEMORY_INJECT_MAX_CHARS
      mockFs({ frontend: "terminal" }, { "memory.md": bigMemory });

      const { loadConfig } = await import("../util/config.js");
      const { MEMORY_INJECT_MAX_CHARS } =
        await import("../core/prompt/assemble.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("Persistent Memory");
      expect(config.systemPrompt).toContain("truncated");
      // The whole prompt stays bounded: memory contributes at most the cap.
      const memorySection = config.systemPrompt
        .split("Persistent Memory")[1]
        .split("---")[0];
      expect(memorySection.length).toBeLessThan(MEMORY_INJECT_MAX_CHARS + 500);
    });

    it("includes workspace file listing when files exist", async () => {
      mockFs({ frontend: "terminal" }, {}, [
        { name: "notes.txt", isDir: false, size: 512 },
        { name: "data.csv", isDir: false, size: 2048 },
      ]);

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("notes.txt");
      expect(config.systemPrompt).toContain("512B");
      expect(config.systemPrompt).toContain("data.csv");
      expect(config.systemPrompt).toContain("2KB");
    });

    it("skips hidden files and node_modules in workspace listing", async () => {
      mockFs({ frontend: "terminal" }, {}, [
        { name: ".hidden", isDir: false, size: 100 },
        { name: "node_modules", isDir: true },
        { name: "talon.log", isDir: false, size: 500 },
        { name: "visible.txt", isDir: false, size: 200 },
      ]);

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("visible.txt");
      expect(config.systemPrompt).not.toContain(".hidden");
      expect(config.systemPrompt).not.toContain("node_modules");
      // Scope to the rendered listing entry ("talon.log (500B)") — the
      // bare substring legitimately appears in prompt docs now (the Lua
      // trigger host API is named talon.log).
      expect(config.systemPrompt).not.toMatch(/talon\.log \(/);
    });

    it("shows subdirectory summary when it has more than 8 files", async () => {
      // Create a subdirectory with > 8 children
      const manyChildren = [];
      for (let i = 0; i < 10; i++) {
        manyChildren.push({ name: `file${i}.txt`, size: 100 });
      }
      mockFs({ frontend: "terminal" }, {}, [
        { name: "bigdir", isDir: true, children: manyChildren },
      ]);

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("bigdir/ (10 files)");
    });

    it("does not stat files inside collapsed (>8) directories", async () => {
      // A collapsed directory renders only a `name/ (N files)` summary, so
      // its files' sizes are never displayed — and must never be stat'd.
      // Statting them eagerly is the blocking-syscall-per-file cost this
      // listing was rewritten to avoid on large workspaces.
      const manyChildren = [];
      for (let i = 0; i < 10; i++) {
        manyChildren.push({ name: `buried${i}.txt`, size: 100 });
      }
      const { statSync } = mockFs({ frontend: "terminal" }, {}, [
        { name: "bigdir", isDir: true, children: manyChildren },
        { name: "top.txt", isDir: false, size: 256 },
      ]);

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();

      // Collapsed summary is shown; the top-level file is stat'd for its size.
      expect(config.systemPrompt).toContain("bigdir/ (10 files)");
      expect(config.systemPrompt).toContain("top.txt (256B)");

      // None of the 10 buried files were stat'd — only the rendered top file.
      const statted = statSync.mock.calls.map((c) => String(c[0]));
      for (let i = 0; i < 10; i++) {
        expect(statted.some((p) => p.endsWith(`buried${i}.txt`))).toBe(false);
      }
      expect(statted.some((p) => p.endsWith("top.txt"))).toBe(true);
    });

    it("lists subdirectory files when 8 or fewer", async () => {
      mockFs({ frontend: "terminal" }, {}, [
        {
          name: "smalldir",
          isDir: true,
          children: [
            { name: "a.txt", size: 50 },
            { name: "b.txt", size: 75 },
          ],
        },
      ]);

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.systemPrompt).toContain("smalldir/a.txt");
      expect(config.systemPrompt).toContain("smalldir/b.txt");
    });

    it("omits empty subdirectory from listing (line 163 FALSE branch: sub.length=0)", async () => {
      // A directory entry with no children → listDir returns [] → sub.length=0
      // → `else if (sub.length > 8)` is FALSE → omitted from listing
      mockFs({ frontend: "terminal" }, {}, [
        { name: "emptydir", isDir: true }, // no children → sub.length = 0
        { name: "notes.txt", isDir: false, size: 100 },
      ]);

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      // The empty subdirectory should NOT appear in listing
      expect(config.systemPrompt).not.toContain("emptydir");
      expect(config.systemPrompt).toContain("notes.txt");
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

      const { loadConfig, rebuildSystemPrompt } =
        await import("../util/config.js");
      const config = loadConfig();
      const originalPrompt = config.systemPrompt;
      rebuildSystemPrompt(config, []);
      expect(config.systemPrompt).toBe(originalPrompt);
    });

    it("appends plugin prompt additions to system prompt", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig, rebuildSystemPrompt } =
        await import("../util/config.js");
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

      const { loadConfig, rebuildSystemPrompt } =
        await import("../util/config.js");
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

      const { loadConfig, rebuildSystemPrompt } =
        await import("../util/config.js");
      const config = loadConfig();
      rebuildSystemPrompt(config, ["## My Plugin\nDo special things."]);
      expect(config.systemPrompt).toContain("Terminal mode active.");
      expect(config.systemPrompt).toContain("Do special things.");
    });

    it("uses telegram as default frontend when config.frontend is undefined", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig, rebuildSystemPrompt } =
        await import("../util/config.js");
      const config = loadConfig();
      // Force frontend to undefined to trigger the ?? "telegram" fallback on line 132
      (config as Record<string, unknown>).frontend = undefined;
      // Should not throw — uses telegram as default frontend file
      expect(() => rebuildSystemPrompt(config, [])).not.toThrow();
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

    it("defaults the canonical Claude model to default", async () => {
      mockFs({ frontend: "terminal" });

      const { loadConfig } = await import("../util/config.js");
      const config = loadConfig();
      expect(config.model).toBe("default");
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
          if (path.includes("config.json") || path.includes("talon.json"))
            return true;
          if (path.endsWith(".talon") || path.endsWith("/data")) return true;
          return false;
        }),
        readFileSync: vi.fn((path: string) => {
          if (path.includes("config.json") || path.includes("talon.json"))
            throw new Error("corrupt file");
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
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
      logDebug: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((path: string) => {
        if (path.includes("config.json")) return true;
        return false;
      }),
      readFileSync: vi.fn(() =>
        JSON.stringify({
          frontend: "teams",
          // teamsWebhookUrl intentionally omitted
        }),
      ),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ size: 0 })),
    }));

    const { loadConfig } = await import("../util/config.js");
    expect(() => loadConfig()).toThrow("teamsWebhookUrl");
  });
});
