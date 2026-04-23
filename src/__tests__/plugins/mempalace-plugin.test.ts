import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Thin tests for the TalonPlugin factory shape. Heal logic has its own
 * dedicated test file — here we only verify things the factory uniquely
 * owns: MCP server wiring, getEnvVars plumbing, getSystemPromptAddition
 * fallback behavior.
 */

vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// Default paths uses dirs/pathFiles — stub a default managed python path.
vi.mock("../../util/paths.js", () => ({
  dirs: { prompts: "/prompts" },
  files: { mempalacePython: "/managed-venv/bin/python" },
}));

const PROMPT_TEMPLATE = `## MemPalace — Long-term Memory\n\nPalace: {{palacePath}}\nLangs: {{entityLanguages}}\n`;

describe("createMempalacePlugin — factory", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("MCP server points at the user's python when pythonPath is provided", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    const { createMempalacePlugin } =
      await import("../../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      pythonPath: "/usr/bin/python3",
      palacePath: "/data/palace",
    });
    expect(plugin.name).toBe("mempalace");
    expect(plugin.mcpServer).toEqual({
      command: "/usr/bin/python3",
      args: ["-m", "mempalace.mcp_server", "--palace", "/data/palace"],
    });
  });

  it("falls back to Talon-managed python when no pythonPath set", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    const { createMempalacePlugin } =
      await import("../../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({ palacePath: "/data/palace" });
    expect(plugin.mcpServer?.command).toBe("/managed-venv/bin/python");
  });

  it("getEnvVars sets palace path; includes languages + verbose when configured", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    const { createMempalacePlugin } =
      await import("../../plugins/mempalace/index.js");
    const plain = createMempalacePlugin({ palacePath: "/p" });
    expect(plain.getEnvVars!({})).toEqual({ MEMPALACE_PALACE_PATH: "/p" });

    const rich = createMempalacePlugin({
      palacePath: "/p",
      entityLanguages: ["en", "ja", "pt-br"],
      verbose: true,
    });
    expect(rich.getEnvVars!({})).toEqual({
      MEMPALACE_PALACE_PATH: "/p",
      MEMPALACE_ENTITY_LANGUAGES: "en,ja,pt-br",
      MEMPAL_VERBOSE: "1",
    });
  });

  it("getSystemPromptAddition substitutes palacePath + entityLanguages", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => PROMPT_TEMPLATE),
    }));
    const { createMempalacePlugin } =
      await import("../../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({
      palacePath: "/p",
      entityLanguages: ["en", "ja"],
    });
    const prompt = plugin.getSystemPromptAddition!({});
    expect(prompt).toContain("Palace: /p");
    expect(prompt).toContain("Langs: en, ja");
  });

  it("getSystemPromptAddition falls back gracefully if prompt file is unreadable", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readFileSync: vi.fn(() => {
        throw new Error("ENOENT: no such file");
      }),
    }));
    const { createMempalacePlugin } =
      await import("../../plugins/mempalace/index.js");
    const plugin = createMempalacePlugin({ palacePath: "/p" });
    const prompt = plugin.getSystemPromptAddition!({});
    expect(prompt).toContain("MemPalace");
    expect(prompt).toContain("/p");
  });
});
