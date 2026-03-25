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

  /** Import fresh plugin module with fs mocked to find entry + dynamic import returning plugin. */
  async function setup(plugin: ReturnType<typeof createMockPlugin>) {
    vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
    const mod = await import("../core/plugin.js");
    mod._deps.importModule = async () => ({ default: plugin });
    return mod;
  }

  describe("PluginRegistry", () => {
    it("registers a plugin and retrieves it by name", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPlugin, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
      expect(getPlugin("test-plugin")).toBeDefined();
      expect(getPlugin("test-plugin")!.plugin.name).toBe("test-plugin");
    });

    it("prevents duplicate plugin names", async () => {
      const plugin = createMockPlugin();
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }, { path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
    });

    it("skips plugins with no entry point", async () => {
      vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => false) }));
      const { loadPlugins, getPluginCount } = await import("../core/plugin.js");
      await loadPlugins([{ path: "/nonexistent/plugin" }]);

      expect(getPluginCount()).toBe(0);
    });

    it("skips plugins missing name", async () => {
      vi.doMock("node:fs", () => ({ existsSync: vi.fn(() => true) }));
      const mod = await import("../core/plugin.js");
      mod._deps.importModule = async () => ({
        default: { handleAction: vi.fn() },
      });
      await mod.loadPlugins([{ path: "/fake/plugin" }]);

      expect(mod.getPluginCount()).toBe(0);
    });
  });

  describe("config validation", () => {
    it("skips plugin when validateConfig returns errors", async () => {
      const plugin = createMockPlugin({
        validateConfig: () => [
          "repoPath is required",
          "jenkinsUrl is required",
        ],
      });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin", config: {} }]);

      expect(getPluginCount()).toBe(0);
    });

    it("loads plugin when validateConfig returns undefined (valid)", async () => {
      const plugin = createMockPlugin({ validateConfig: () => undefined });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([
        { path: "/fake/plugin", config: { repoPath: "/tmp" } },
      ]);

      expect(getPluginCount()).toBe(1);
    });
  });

  describe("env vars", () => {
    it("sets env vars from getEnvVars on process.env", async () => {
      const plugin = createMockPlugin({
        getEnvVars: () => ({ TEST_PLUGIN_FOO: "bar", TEST_PLUGIN_BAZ: "qux" }),
      });
      const { loadPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(process.env.TEST_PLUGIN_FOO).toBe("bar");
      expect(process.env.TEST_PLUGIN_BAZ).toBe("qux");
    });
  });

  describe("action routing", () => {
    it("routes action to the correct plugin", async () => {
      const plugin = createMockPlugin({
        handleAction: vi.fn(async (body: Record<string, unknown>) => {
          if (body.action === "test_action")
            return { ok: true, text: "handled" };
          return null;
        }),
      });
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction(
        { action: "test_action" },
        "chat1",
      );
      expect(result).toEqual({ ok: true, text: "handled" });
    });

    it("returns null when no plugin handles the action", async () => {
      const plugin = createMockPlugin({
        handleAction: vi.fn(async () => null),
      });
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "unknown" }, "chat1");
      expect(result).toBeNull();
    });

    it("catches plugin action errors and returns error result", async () => {
      const plugin = createMockPlugin({
        handleAction: vi.fn(async () => {
          throw new Error("plugin crash");
        }),
      });
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "boom" }, "chat1");
      expect(result?.ok).toBe(false);
      expect(result?.error).toContain("plugin crash");
    });

    it("skips plugins without handleAction", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).handleAction;
      const { loadPlugins, handlePluginAction } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const result = await handlePluginAction({ action: "test" }, "chat1");
      expect(result).toBeNull();
    });
  });

  describe("MCP server config", () => {
    it("builds MCP server entries for plugins with mcpServerPath", async () => {
      const plugin = createMockPlugin({
        mcpServerPath: "/fake/tools.ts",
        getEnvVars: () => ({ MY_KEY: "val" }),
      });
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(servers["test-plugin-tools"]).toBeDefined();
      expect(servers["test-plugin-tools"].env.TALON_BRIDGE_URL).toBe(
        "http://localhost:19876",
      );
      expect(servers["test-plugin-tools"].env.TALON_CHAT_ID).toBe("chat1");
      expect(servers["test-plugin-tools"].env.MY_KEY).toBe("val");
    });

    it("skips plugins without mcpServerPath", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).mcpServerPath;
      const { loadPlugins, getPluginMcpServers } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const servers = getPluginMcpServers("http://localhost:19876", "chat1");
      expect(Object.keys(servers)).toHaveLength(0);
    });
  });

  describe("system prompt additions", () => {
    it("collects prompt additions from plugins", async () => {
      const plugin = createMockPlugin({
        getSystemPromptAddition: () => "## My Plugin\nI add context.",
      });
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      const additions = getPluginPromptAdditions();
      expect(additions).toHaveLength(1);
      expect(additions[0]).toContain("My Plugin");
    });

    it("handles plugins without getSystemPromptAddition", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).getSystemPromptAddition;
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginPromptAdditions()).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("calls init with config", async () => {
      const initFn = vi.fn();
      const plugin = createMockPlugin({ init: initFn });
      const { loadPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin", config: { key: "val" } }]);

      expect(initFn).toHaveBeenCalledWith({ key: "val" });
    });

    it("calls destroy on all plugins", async () => {
      const destroyFn = vi.fn();
      const plugin = createMockPlugin({ destroy: destroyFn });
      const { loadPlugins, destroyPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);
      await destroyPlugins();

      expect(destroyFn).toHaveBeenCalled();
    });

    it("still registers plugin if init throws", async () => {
      const plugin = createMockPlugin({
        init: () => {
          throw new Error("init failed");
        },
      });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginCount()).toBe(1);
    });

    it("catches destroy errors without crashing", async () => {
      const plugin = createMockPlugin({
        destroy: () => {
          throw new Error("destroy crash");
        },
      });
      const { loadPlugins, destroyPlugins } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      await expect(destroyPlugins()).resolves.toBeUndefined();
    });
  });

  describe("frontend whitelist", () => {
    it("skips plugin when frontend whitelist doesn't match", async () => {
      const plugin = createMockPlugin({ frontends: ["telegram"] });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }], ["terminal"]);

      expect(getPluginCount()).toBe(0);
    });

    it("loads plugin when frontend whitelist matches", async () => {
      const plugin = createMockPlugin({ frontends: ["telegram", "terminal"] });
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }], ["terminal"]);

      expect(getPluginCount()).toBe(1);
    });

    it("loads plugin when no frontend whitelist is specified", async () => {
      const plugin = createMockPlugin();
      delete (plugin as Record<string, unknown>).frontends;
      const { loadPlugins, getPluginCount } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }], ["terminal"]);

      expect(getPluginCount()).toBe(1);
    });
  });

  describe("prompt addition error handling", () => {
    it("catches getSystemPromptAddition errors without crashing", async () => {
      const plugin = createMockPlugin({
        getSystemPromptAddition: () => {
          throw new Error("prompt error");
        },
      });
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginPromptAdditions()).toHaveLength(0);
    });

    it("skips empty/whitespace prompt additions", async () => {
      const plugin = createMockPlugin({
        getSystemPromptAddition: () => "   \n  ",
      });
      const { loadPlugins, getPluginPromptAdditions } = await setup(plugin);
      await loadPlugins([{ path: "/fake/plugin" }]);

      expect(getPluginPromptAdditions()).toHaveLength(0);
    });
  });
});
