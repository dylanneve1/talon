import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("picocolors", () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    yellow: (s: string) => s,
    underline: (s: string) => s,
  },
}));

// Mock storage modules that commands import dynamically.
// We use wrapper functions so vi.fn() instances can be swapped per-test.
const mockGetChatSettings = vi.fn(
  (_chatId: string): Record<string, unknown> => ({}),
);
const mockSetChatModel = vi.fn();
const mockSetChatEffort = vi.fn();
const mockResolveModelName = vi.fn((s: string) => `claude-${s}`);
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: (chatId: string) => mockGetChatSettings(chatId),
  setChatModel: (chatId: string, model: string) =>
    mockSetChatModel(chatId, model),
  setChatEffort: (chatId: string, effort: string | undefined) =>
    mockSetChatEffort(chatId, effort),
  resolveModelName: (s: string) => mockResolveModelName(s),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetSessionInfo = vi.fn((_chatId: string): any => ({
  turns: 0,
  usage: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    lastPromptTokens: 0,
    estimatedCostUsd: 0,
    totalResponseMs: 0,
    lastResponseMs: 0,
    fastestResponseMs: Infinity,
  },
}));
const mockSetSessionName = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAllSessions = vi.fn((): any[] => []);
vi.mock("../storage/sessions.js", () => ({
  getSessionInfo: (chatId: string) => mockGetSessionInfo(chatId),
  setSessionName: (chatId: string, name: string) =>
    mockSetSessionName(chatId, name),
  getAllSessions: () => mockGetAllSessions(),
}));

vi.mock("../core/plugin.js", () => ({
  getLoadedPlugins: () => [],
}));

import {
  registerCommand,
  tryRunCommand,
  getCommands,
  clearCommands,
  registerBuiltinCommands,
  type CommandContext,
} from "../frontend/terminal/commands.js";

// ── Test helper ──────────────────────────────────────────────────────────────

function makeMockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    chatId: () => "t_test_123",
    config: { model: "claude-sonnet-4-6" } as CommandContext["config"],
    renderer: {
      cols: 100,
      writeln: vi.fn(),
      writeSystem: vi.fn(),
      writeError: vi.fn(),
      renderAssistantMessage: vi.fn(),
      renderToolCall: vi.fn(),
      renderStats: vi.fn(),
      startSpinner: vi.fn(),
      updateSpinnerLabel: vi.fn(),
      stopSpinner: vi.fn(),
      updateStatusBar: vi.fn(),
    } as unknown as CommandContext["renderer"],
    reprompt: vi.fn(),
    initNewChat: vi.fn(),
    waitForInput: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
    ...overrides,
  };
}

// ── Registry ─────────────────────────────────────────────────────────────────

describe("command registry", () => {
  beforeEach(() => {
    clearCommands();
  });

  it("registers and retrieves commands", () => {
    registerCommand({
      name: "test",
      description: "A test command",
      handler: vi.fn(),
    });
    expect(getCommands()).toHaveLength(1);
    expect(getCommands()[0]!.name).toBe("test");
  });

  it("clearCommands empties the registry", () => {
    registerCommand({
      name: "test",
      description: "A test",
      handler: vi.fn(),
    });
    clearCommands();
    expect(getCommands()).toHaveLength(0);
  });

  it("tryRunCommand returns false for non-slash text", async () => {
    const ctx = makeMockContext();
    expect(await tryRunCommand("hello world", ctx)).toBe(false);
  });

  it("tryRunCommand returns false for unknown slash command", async () => {
    const ctx = makeMockContext();
    expect(await tryRunCommand("/unknown", ctx)).toBe(false);
  });

  it("tryRunCommand dispatches to registered handler", async () => {
    const handler = vi.fn();
    registerCommand({ name: "ping", description: "Ping", handler });
    const ctx = makeMockContext();

    const result = await tryRunCommand("/ping", ctx);
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith("", ctx);
  });

  it("tryRunCommand passes args after command name", async () => {
    const handler = vi.fn();
    registerCommand({ name: "echo", description: "Echo", handler });
    const ctx = makeMockContext();

    await tryRunCommand("/echo hello world", ctx);
    expect(handler).toHaveBeenCalledWith("hello world", ctx);
  });

  it("tryRunCommand supports aliases", async () => {
    const handler = vi.fn();
    registerCommand({
      name: "quit",
      aliases: ["exit", "q"],
      description: "Quit",
      handler,
    });
    const ctx = makeMockContext();

    await tryRunCommand("/exit", ctx);
    expect(handler).toHaveBeenCalledTimes(1);

    await tryRunCommand("/q", ctx);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("tryRunCommand is case-insensitive for command names", async () => {
    const handler = vi.fn();
    registerCommand({ name: "test", description: "Test", handler });
    const ctx = makeMockContext();

    await tryRunCommand("/TEST", ctx);
    expect(handler).toHaveBeenCalled();
  });
});

// ── Built-in commands ────────────────────────────────────────────────────────

describe("built-in commands", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
    vi.clearAllMocks();
  });

  it("registers all expected commands", () => {
    const names = getCommands().map((c) => c.name);
    expect(names).toContain("model");
    expect(names).toContain("effort");
    expect(names).toContain("status");
    expect(names).toContain("reset");
    expect(names).toContain("resume");
    expect(names).toContain("rename");
    expect(names).toContain("help");
    expect(names).toContain("quit");
  });

  it("/reset calls initNewChat and reprompt", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/reset", ctx);
    expect(ctx.initNewChat).toHaveBeenCalled();
    expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Session cleared.");
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  it("/quit calls close", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/quit", ctx);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("/exit also calls close (alias)", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/exit", ctx);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("/help lists commands via renderer.writeln", async () => {
    const ctx = makeMockContext();
    await tryRunCommand("/help", ctx);
    const writelnMock = ctx.renderer.writeln as ReturnType<typeof vi.fn>;
    expect(writelnMock.mock.calls.length).toBeGreaterThanOrEqual(
      getCommands().length,
    );
    expect(ctx.reprompt).toHaveBeenCalled();
  });

  describe("/model", () => {
    it("shows current model when no arg given", async () => {
      mockGetChatSettings.mockReturnValueOnce({ model: "claude-opus-4-6" });
      const ctx = makeMockContext();
      await tryRunCommand("/model", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("claude-opus-4-6"),
      );
    });

    it("sets model when arg given", async () => {
      const ctx = makeMockContext();
      await tryRunCommand("/model opus", ctx);
      expect(mockSetChatModel).toHaveBeenCalledWith(
        "t_test_123",
        "claude-opus",
      );
    });
  });

  describe("/rename", () => {
    it("shows current name when session has one", async () => {
      mockGetSessionInfo.mockReturnValueOnce({
        sessionName: "my session",
        turns: 0,
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          lastPromptTokens: 0,
          estimatedCostUsd: 0,
          totalResponseMs: 0,
          lastResponseMs: 0,
          fastestResponseMs: Infinity,
        },
      });
      const ctx = makeMockContext();
      await tryRunCommand("/rename", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("my session"),
      );
    });

    it("shows 'no name' when session is unnamed", async () => {
      mockGetSessionInfo.mockReturnValueOnce({
        turns: 0,
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheRead: 0,
          totalCacheWrite: 0,
          lastPromptTokens: 0,
          estimatedCostUsd: 0,
          totalResponseMs: 0,
          lastResponseMs: 0,
          fastestResponseMs: Infinity,
        },
      });
      const ctx = makeMockContext();
      await tryRunCommand("/rename", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        "Session has no name.",
      );
    });

    it("sets name when arg provided", async () => {
      const ctx = makeMockContext();
      await tryRunCommand("/rename new name", ctx);
      expect(mockSetSessionName).toHaveBeenCalledWith("t_test_123", "new name");
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("new name"),
      );
    });
  });

  describe("/resume", () => {
    it("shows message when no sessions exist", async () => {
      mockGetAllSessions.mockReturnValueOnce([]);
      const ctx = makeMockContext();
      await tryRunCommand("/resume", ctx);
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        "No previous sessions to resume.",
      );
    });

    it("lists sessions and resumes on valid selection", async () => {
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_old_session",
          info: {
            turns: 5,
            lastActive: Date.now() - 3600_000,
            sessionName: "debugging",
            lastModel: "claude-opus-4-6",
          },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue("1"),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).toHaveBeenCalledWith("t_old_session");
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith(
        expect.stringContaining("Resumed"),
      );
    });

    it("cancels on empty input", async () => {
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_old",
          info: { turns: 1, lastActive: Date.now() },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue(""),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).not.toHaveBeenCalled();
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Cancelled.");
    });

    it("cancels on invalid number", async () => {
      mockGetAllSessions.mockReturnValueOnce([
        {
          chatId: "t_old",
          info: { turns: 1, lastActive: Date.now() },
        },
      ]);
      const ctx = makeMockContext({
        waitForInput: vi.fn().mockResolvedValue("99"),
      });
      await tryRunCommand("/resume", ctx);
      expect(ctx.initNewChat).not.toHaveBeenCalled();
      expect(ctx.renderer.writeSystem).toHaveBeenCalledWith("Cancelled.");
    });
  });
});
