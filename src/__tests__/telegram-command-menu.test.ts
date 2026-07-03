/**
 * telegramCommandMenu — the /update entry must track the exact gate its
 * handler uses (devBuild + git checkout), so the Telegram menu never
 * advertises a command that isn't registered, and dev builds actually
 * see /update in the menu (it used to be wired but unlisted).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetRepoRoot = vi.fn<() => string | null>(() => "/repo");

vi.mock("../core/update/self-update.js", () => ({
  getRepoRoot: () => mockGetRepoRoot(),
}));

import {
  TELEGRAM_COMMANDS,
  telegramCommandMenu,
} from "../frontend/telegram/commands/definitions.js";

describe("telegramCommandMenu", () => {
  beforeEach(() => {
    mockGetRepoRoot.mockReturnValue("/repo");
  });

  it("includes /update right after /restart on dev builds from a checkout", () => {
    const menu = telegramCommandMenu({ devBuild: true });
    const names = menu.map((c) => c.command);
    expect(names.indexOf("update")).toBe(names.indexOf("restart") + 1);
  });

  it("omits /update on non-dev builds", () => {
    const names = telegramCommandMenu({ devBuild: false }).map(
      (c) => c.command,
    );
    expect(names).not.toContain("update");
  });

  it("omits /update when there is no git checkout (packaged binary)", () => {
    mockGetRepoRoot.mockReturnValue(null);
    const names = telegramCommandMenu({ devBuild: true }).map((c) => c.command);
    expect(names).not.toContain("update");
  });

  it("never mutates the base menu", () => {
    const before = TELEGRAM_COMMANDS.length;
    telegramCommandMenu({ devBuild: true });
    expect(TELEGRAM_COMMANDS.length).toBe(before);
    expect(TELEGRAM_COMMANDS.map((c) => c.command)).not.toContain("update");
  });
});
