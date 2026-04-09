import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

describe("mempalace plugin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("creates a plugin with correct name and MCP server config", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "Palace: 42 drawers"),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    expect(plugin.name).toBe("mempalace");
    expect(plugin.version).toBe("1.0.0");
    expect(plugin.mcpServer).toEqual({
      command: "/venv/bin/python",
      args: ["-m", "mempalace.mcp_server", "--palace", "/data/palace"],
    });
  });

  it("validateConfig returns error when python binary not found", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/nonexistent/python",
      palacePath: "/data/palace",
    });

    const errors = plugin.validateConfig!({});
    expect(errors).toBeDefined();
    expect(errors!.length).toBeGreaterThan(0);
    expect(errors![0]).toContain("Python binary not found");
  });

  it("validateConfig passes when python binary exists", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    const errors = plugin.validateConfig!({});
    expect(errors).toBeUndefined();
  });

  it("init creates palace directory if missing", async () => {
    const mkdirSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((p: string) =>
        p === "/venv/bin/python" ? true : false,
      ),
      mkdirSync: mkdirSyncMock,
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "ok"),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/new-palace",
    });

    await plugin.init!({});
    expect(mkdirSyncMock).toHaveBeenCalledWith("/data/new-palace", {
      recursive: true,
    });
  });

  it("init logs warning when mempalace is not importable", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => {
        throw new Error("ModuleNotFoundError");
      }),
    }));

    const { logError } = (await import("../util/log.js")) as unknown as {
      logError: ReturnType<typeof vi.fn>;
    };

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    await plugin.init!({});
    expect(logError).toHaveBeenCalledWith(
      "mempalace",
      expect.stringContaining("mempalace not installed"),
    );
  });

  it("getEnvVars returns MEMPALACE_PALACE_PATH", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    expect(plugin.getEnvVars!({})).toEqual({
      MEMPALACE_PALACE_PATH: "/data/palace",
    });
  });

  it("getSystemPromptAddition includes palace path and tool descriptions", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/custom/palace",
    });

    const addition = plugin.getSystemPromptAddition!({});
    expect(addition).toContain("MemPalace");
    expect(addition).toContain("mempalace_search");
    expect(addition).toContain("mempalace_add_drawer");
    expect(addition).toContain("mempalace_kg_query");
    expect(addition).toContain("/custom/palace");
  });
});
