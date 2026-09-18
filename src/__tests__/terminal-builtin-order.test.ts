/**
 * Terminal builtins — the registration order and alias table.
 *
 * `registerBuiltinCommands()` used to be one function registering every
 * command inline; the order it produced is what `/help` prints and what
 * `getCommands()` returns, so the static list that replaced it is pinned here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage/history.js", () => ({ getRecentHistory: vi.fn(() => []) }));
vi.mock("../storage/chat-settings.js", () => ({
  getChatSettings: vi.fn(() => ({})),
  setChatModel: vi.fn(),
  setChatEffort: vi.fn(),
}));
vi.mock("../storage/sessions.js", () => ({
  getSession: vi.fn(),
  getSessionInfo: vi.fn(),
  setSessionName: vi.fn(),
  getAllSessions: vi.fn(() => []),
}));
vi.mock("../core/plugin/index.js", () => ({
  getLoadedPlugins: vi.fn(() => []),
}));

import { BUILTIN_COMMANDS } from "../frontend/terminal/builtins/index.js";
import {
  clearCommands,
  getCommands,
  registerBuiltinCommands,
  tryRunCommand,
  type CommandContext,
} from "../frontend/terminal/commands.js";

const ORDER = [
  "model",
  "effort",
  "status",
  "context",
  "reset",
  "resume",
  "rename",
  "help",
  "quit",
];

const ALIASES: Record<string, string[]> = {
  context: ["ctx"],
  quit: ["exit"],
};

describe("terminal builtin registration order", () => {
  beforeEach(() => {
    clearCommands();
    registerBuiltinCommands();
  });

  it("BUILTIN_COMMANDS lists every builtin exactly once, in order", () => {
    expect(BUILTIN_COMMANDS.map((c) => c.name)).toEqual(ORDER);
  });

  it("registerBuiltinCommands registers them in that same order", () => {
    expect(getCommands().map((c) => c.name)).toEqual(ORDER);
    expect(getCommands()).toHaveLength(ORDER.length);
  });

  it("only /context and /quit carry aliases", () => {
    const table: Record<string, string[]> = {};
    for (const c of BUILTIN_COMMANDS) {
      if (c.aliases) table[c.name] = c.aliases;
    }
    expect(table).toEqual(ALIASES);
  });

  it("every name and alias resolves through tryRunCommand", async () => {
    const close = vi.fn();
    const ctx = {
      chatId: () => "t_x",
      config: { model: "m" },
      renderer: {
        writeln: vi.fn(),
        writeSystem: vi.fn(),
        writeError: vi.fn(),
      },
      reprompt: vi.fn(),
      initNewChat: vi.fn(),
      waitForInput: vi.fn(async () => ""),
      close,
    } as unknown as CommandContext;

    expect(await tryRunCommand("/exit", ctx)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await tryRunCommand("/quit", ctx)).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(await tryRunCommand("/nope", ctx)).toBe(false);
  });
});
