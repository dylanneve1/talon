import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const PROMPT_TEMPLATE = `## MemPalace — Long-term Memory

mempalace_search mempalace_add_drawer mempalace_kg_query mempalace_kg_invalidate
mempalace_kg_timeline mempalace_traverse mempalace_find_tunnels
mempalace_diary_write mempalace_diary_read mempalace_delete_drawer
Protocol

### Palace location: \`{{palacePath}}\`
`;

describe("mempalace plugin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("creates a plugin with correct name and MCP server config", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "ok"),
      execFile: vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          cb(null, { stdout: "Palace: 42 drawers", stderr: "" });
        },
      ),
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
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(),
      execFile: vi.fn(),
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

  it("validateConfig passes when python binary exists and mempalace is importable", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "ok"),
      execFile: vi.fn(),
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

  it("validateConfig returns error when mempalace is not importable", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => {
        throw new Error("ModuleNotFoundError");
      }),
      execFile: vi.fn(),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    const errors = plugin.validateConfig!({});
    expect(errors).toBeDefined();
    expect(errors!.length).toBeGreaterThan(0);
    expect(errors![0]).toContain("mempalace package not installed");
  });

  it("init creates palace directory if missing", async () => {
    const mkdirSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn((p: string) =>
        p === "/venv/bin/python" ? true : false,
      ),
      mkdirSync: mkdirSyncMock,
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => "ok"),
      execFile: vi.fn(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (
            err: Error | null,
            result: { stdout: string; stderr: string },
          ) => void,
        ) => {
          cb(null, { stdout: "ok", stderr: "" });
        },
      ),
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

  it("validateConfig returns error when python binary exists but mempalace import fails with ENOENT", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(() => {
        const err = new Error("spawn ENOENT") as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }),
      execFile: vi.fn(),
    }));

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    const errors = plugin.validateConfig!({});
    expect(errors).toBeDefined();
    expect(errors!.length).toBeGreaterThan(0);
    expect(errors![0]).toContain("Cannot execute Python");
    expect(errors![0]).toContain("ENOENT");
  });

  it("getEnvVars returns MEMPALACE_PALACE_PATH", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(),
      execFile: vi.fn(),
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

  it("getSystemPromptAddition loads from .md file and interpolates palacePath", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(),
      execFile: vi.fn(),
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
    expect(addition).toContain("mempalace_kg_invalidate");
    expect(addition).toContain("mempalace_kg_timeline");
    expect(addition).toContain("mempalace_traverse");
    expect(addition).toContain("mempalace_find_tunnels");
    expect(addition).toContain("mempalace_diary_write");
    expect(addition).toContain("mempalace_diary_read");
    expect(addition).toContain("mempalace_delete_drawer");
    expect(addition).toContain("Protocol");
    expect(addition).toContain("/custom/palace");
    // Verify interpolation happened — no raw placeholder
    expect(addition).not.toContain("{{palacePath}}");
  });

  it("getSystemPromptAddition returns fallback when .md file is missing", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => {
        throw new Error("ENOENT: no such file");
      }),
    }));
    vi.doMock("node:child_process", () => ({
      execFileSync: vi.fn(),
      execFile: vi.fn(),
    }));

    const { logWarn } = (await import("../util/log.js")) as unknown as {
      logWarn: ReturnType<typeof vi.fn>;
    };

    const { createMempalacePlugin } =
      await import("../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/venv/bin/python",
      palacePath: "/data/palace",
    });

    const addition = plugin.getSystemPromptAddition!({});
    expect(addition).toContain("MemPalace");
    expect(addition).toContain("/data/palace");
    expect(logWarn).toHaveBeenCalledWith(
      "mempalace",
      expect.stringContaining("Failed to load prompt"),
    );
  });
});
