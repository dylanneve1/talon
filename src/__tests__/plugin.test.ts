import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

describe("plugin system", () => {
  beforeEach(() => {
    vi.resetModules();
    // Clean env vars that plugins might set
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TEST_PLUGIN_")) delete process.env[key];
    }
  });

  function createMockPlugin(overrides: Record<string, unknown> = {}) {
    return {
      name: "test-plugin",
      version: "1.0.0",
      description: "Test plugin",
      mcpServerPath: "/fake/tools.ts",
      getEnvVars: vi.fn(() => ({ TEST_PLUGIN_KEY: "value" })),
      handleAction: vi.fn(async () => null),
      ...overrides,
    };
  }

  describe("PluginRegistry", () => {
    it("registers a plugin and retrieves it by name", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin();
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPlugin, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
      expect(getPlugin("test-plugin")).toBeDefined();
      expect(getPlugin("test-plugin")!.plugin.name).toBe("test-plugin");
    });

    it("prevents duplicate plugin names", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin();
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([
        { path: "/fake/plugin" },
        { path: "/fake/plugin" }, // duplicate
      ]);

      expect(getPluginCount()).toBe(1);
    });

    it("skips plugins with no entry point", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => false), // no entry point found
      }));

      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/nonexistent/plugin" }]);

      expect(getPluginCount()).toBe(0);
    });

    it("skips plugins missing name", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));
      vi.doMock("/fake/plugin/src/index.ts", () => ({
        default: { handleAction: vi.fn() }, // no name
      }));

      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(0);
    });
  });

  describe("config validation", () => {
    it("skips plugin when validateConfig returns errors", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        validateConfig: () => ["repoPath is required", "jenkinsUrl is required"],
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin", config: {} }]);

      expect(getPluginCount()).toBe(0);
    });

    it("loads plugin when validateConfig returns undefined (valid)", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        validateConfig: () => undefined,
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin", config: { repoPath: "/tmp" } }]);

      expect(getPluginCount()).toBe(1);
    });
  });

  describe("env vars", () => {
    it("sets env vars from getEnvVars on process.env", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        getEnvVars: () => ({ TEST_PLUGIN_FOO: "bar", TEST_PLUGIN_BAZ: "qux" }),
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(process.env.TEST_PLUGIN_FOO).toBe("bar");
      expect(process.env.TEST_PLUGIN_BAZ).toBe("qux");
    });
  });

  describe("action routing", () => {
    it("routes action to the correct plugin", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        handleAction: vi.fn(async (body: Record<string, unknown>) => {
          if (body.action === "test_action") return { ok: true, text: "handled" };
          return null;
        }),
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, handlePluginAction } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "test_action" }, "chat1");
      expect(result).toEqual({ ok: true, text: "handled" });
    });

    it("returns null when no plugin handles the action", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        handleAction: vi.fn(async () => null),
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, handlePluginAction } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "unknown" }, "chat1");
      expect(result).toBeNull();
    });

    it("catches plugin action errors and returns error result", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        handleAction: vi.fn(async () => { throw new Error("plugin crash"); }),
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, handlePluginAction } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "boom" }, "chat1");
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("plugin crash");
    });

    it("skips plugins without handleAction", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).handleAction;
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, handlePluginAction } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "test" }, "chat1");
      expect(result).toBeNull();
    });
  });

  describe("MCP server config", () => {
    it("builds MCP server entries for plugins with mcpServerPath", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        mcpServerPath: "/fake/tools.ts",
        getEnvVars: () => ({ MY_KEY: "val" }),
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginMcpServers } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(servers["test-plugin-tools"]).toBeDefined();
      expect(servers["test-plugin-tools"].env.TALON_BRIDGE_URL).toBe("http://localhost:19876");
      expect(servers["test-plugin-tools"].env.TALON_CHAT_ID).toBe("chat1");
      expect(servers["test-plugin-tools"].env.MY_KEY).toBe("val");
    });

    it("skips plugins without mcpServerPath", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).mcpServerPath;
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginMcpServers } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(Object.keys(servers)).toHaveLength(0);
    });
  });

  describe("system prompt additions", () => {
    it("collects prompt additions from plugins", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        getSystemPromptAddition: () => "## My Plugin\nI add context.",
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginPromptAdditions } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const additions = getPluginPromptAdditions();
      expect(additions).toHaveLength(1);
      expect(additions[0]).toContain("My Plugin");
    });

    it("handles plugins without getSystemPromptAddition", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).getSystemPromptAddition;
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginPromptAdditions } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      const additions = getPluginPromptAdditions();
      expect(additions).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("calls init with config", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const initFn = vi.fn();
      const plugin = createMockPlugin({ init: initFn });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin", config: { key: "val" } }]);

      expect(initFn).toHaveBeenCalledWith({ key: "val" });
    });

    it("calls destroy on all plugins", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const destroyFn = vi.fn();
      const plugin = createMockPlugin({ destroy: destroyFn });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, destroyPlugins } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);
      await destroyPlugins();

      expect(destroyFn).toHaveBeenCalled();
    });

    it("still registers plugin if init throws", async () => {
      vi.doMock("node:fs", () => ({
        existsSync: vi.fn(() => true),
      }));

      const plugin = createMockPlugin({
        init: () => { throw new Error("init failed"); },
      });
      vi.doMock("/fake/plugin/src/index.ts", () => ({ default: plugin }));

      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/fake/plugin" }]);

      // Plugin is registered even if init fails (tools may still work)
      expect(getPluginCount()).toBe(1);
    });
  });
});
