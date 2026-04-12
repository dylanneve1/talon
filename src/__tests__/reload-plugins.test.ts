import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

// Mock cheerio (required by gateway-actions via extractText)
vi.mock("cheerio", () => ({
  load: vi.fn(() => {
    const $ = (sel: string) => ({
      remove: vi.fn(),
      text: () => "",
    });
    ($ as any).root = vi.fn();
    return $;
  }),
}));

// Mock storage modules required by gateway-actions
vi.mock("../storage/history.js", () => ({
  getRecentFormatted: vi.fn(() => ""),
  searchHistory: vi.fn(() => ""),
  getMessagesByUser: vi.fn(() => ""),
  getKnownUsers: vi.fn(() => ""),
}));
vi.mock("../storage/media-index.js", () => ({
  formatMediaIndex: vi.fn(() => ""),
}));
vi.mock("../storage/cron-store.js", () => ({
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  getCronJobsForChat: vi.fn(() => []),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  validateCronExpression: vi.fn(() => ({ valid: true })),
  generateCronId: vi.fn(() => "test-id"),
}));

// ── Plugin mocking ─────────────────────────────────────────────────���──────

const DEFAULT_CONFIG = {
  model: "claude-opus-4-6",
  frontend: "telegram",
  plugins: [],
  systemPrompt: "test prompt",
};

const mockReloadPlugins = vi.fn(async () => ({
  names: ["extras", "brave-search"],
  config: { ...DEFAULT_CONFIG },
}));
const mockGetPluginPromptAdditions = vi.fn(() => "prompt additions");
const mockRebuildSystemPrompt = vi.fn();
const mockUpdateSystemPrompt = vi.fn();

vi.mock("../core/plugin.js", () => ({
  reloadPlugins: (...args: unknown[]) =>
    mockReloadPlugins(...(args as Parameters<typeof mockReloadPlugins>)),
  getPluginPromptAdditions: () => mockGetPluginPromptAdditions(),
}));

vi.mock("../util/config.js", () => ({
  rebuildSystemPrompt: (...args: unknown[]) =>
    mockRebuildSystemPrompt(
      ...(args as Parameters<typeof mockRebuildSystemPrompt>),
    ),
}));

vi.mock("../backend/claude-sdk/index.js", () => ({
  updateSystemPrompt: (...args: unknown[]) =>
    mockUpdateSystemPrompt(
      ...(args as Parameters<typeof mockUpdateSystemPrompt>),
    ),
}));

// ── Import after mocks ────────────────────────────────────────────────────

import { handleSharedAction } from "../core/gateway-actions.js";

// ── Tests ─────────────────────────────────────────────────────────────────

describe("reload_plugins gateway action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish default implementations after reset
    mockReloadPlugins.mockImplementation(async () => ({
      names: ["extras", "brave-search"],
      config: { ...DEFAULT_CONFIG },
    }));
    mockGetPluginPromptAdditions.mockReturnValue("prompt additions");
    mockRebuildSystemPrompt.mockImplementation(() => {});
    mockUpdateSystemPrompt.mockImplementation(() => {});
  });

  it("returns loaded plugin names on success", async () => {
    const result = await handleSharedAction(
      { action: "reload_plugins" },
      12345,
    );
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(true);
    expect(result!.text).toContain("Plugins reloaded successfully");
    expect(result!.text).toContain("extras");
    expect(result!.text).toContain("brave-search");
    expect(result!.text).toContain("(2)");
  });

  it("calls reloadPlugins without explicit frontends (derived from config)", async () => {
    await handleSharedAction({ action: "reload_plugins" }, 12345);
    // Gateway no longer passes frontends — reloadPlugins derives them from config
    expect(mockReloadPlugins).toHaveBeenCalledWith();
  });

  it("rebuilds system prompt after reloading", async () => {
    await handleSharedAction({ action: "reload_plugins" }, 12345);
    expect(mockRebuildSystemPrompt).toHaveBeenCalledTimes(1);
    expect(mockGetPluginPromptAdditions).toHaveBeenCalledTimes(1);
  });

  it("updates backend system prompt after rebuild", async () => {
    await handleSharedAction({ action: "reload_plugins" }, 12345);
    expect(mockUpdateSystemPrompt).toHaveBeenCalledTimes(1);
  });

  it("returns error when reloadPlugins throws", async () => {
    mockReloadPlugins.mockRejectedValueOnce(
      new Error("Config validation failed"),
    );
    const result = await handleSharedAction(
      { action: "reload_plugins" },
      12345,
    );
    expect(result).not.toBeNull();
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("Config validation failed");
  });

  it("returns error when config is malformed", async () => {
    mockReloadPlugins.mockRejectedValueOnce(
      new Error("Invalid JSON in config"),
    );
    const result = await handleSharedAction(
      { action: "reload_plugins" },
      12345,
    );
    expect(result!.ok).toBe(false);
    expect(result!.error).toContain("Invalid JSON in config");
  });

  it("reports zero plugins when none configured", async () => {
    mockReloadPlugins.mockImplementation(async () => ({
      names: [],
      config: { ...DEFAULT_CONFIG },
    }));
    const result = await handleSharedAction(
      { action: "reload_plugins" },
      12345,
    );
    expect(result!.ok).toBe(true);
    expect(result!.text).toContain("(0)");
    expect(result!.text).toContain("(none)");
  });
});

// ── Admin tool description tests ──────────────────────────────────────────

describe("admin tool description", () => {
  it("does not mention session reset or MCP subprocesses", async () => {
    const { adminTools } = await import("../core/tools/admin.js");
    const reloadTool = adminTools.find((t) => t.name === "reload_plugins");
    expect(reloadTool).toBeDefined();
    expect(reloadTool!.description).not.toContain("resets sessions");
    expect(reloadTool!.description).not.toContain("sessions reset");
    expect(reloadTool!.description).not.toContain("MCP subprocesses");
    expect(reloadTool!.description).toContain("without restarting");
    expect(reloadTool!.description).toContain("without downtime");
  });

  it("mentions env var cleanup", async () => {
    const { adminTools } = await import("../core/tools/admin.js");
    const reloadTool = adminTools.find((t) => t.name === "reload_plugins");
    expect(reloadTool!.description).toContain("env vars");
  });

  it("has admin tag", async () => {
    const { adminTools } = await import("../core/tools/admin.js");
    const reloadTool = adminTools.find((t) => t.name === "reload_plugins");
    expect(reloadTool!.tag).toBe("admin");
  });
});
