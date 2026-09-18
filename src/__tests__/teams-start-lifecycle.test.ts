/**
 * Teams' half of the frontend lifecycle contract: the receive side is a
 * poll timer on the runtime, so `start()` is finished once the first
 * poll is done. It used to park on `new Promise(() => {})` instead,
 * which held the boot open for the daemon's whole life.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const startPolling = vi.fn(async () => {});
const stopPolling = vi.fn();
vi.mock("../frontend/teams/poll.js", () => ({
  startPolling: (...args: unknown[]) => startPolling(...(args as [])),
  stopPolling: (...args: unknown[]) => stopPolling(...(args as [])),
}));

vi.mock("../frontend/teams/actions.js", () => ({
  createTeamsActionHandler: vi.fn(() => vi.fn()),
}));

vi.mock("../frontend/teams/graph.js", () => ({
  initGraphClient: vi.fn(async () => ({
    getMe: async () => ({ id: "me-id", displayName: "Talon" }),
    getStoredChatId: () => "19:chat@thread.v2",
  })),
}));

vi.mock("../frontend/teams/chat-discovery.js", () => ({
  resolveChatId: vi.fn(async () => "19:chat@thread.v2"),
  seedLastSeen: vi.fn(async () => {}),
}));

const { createTeamsFrontend } = await import("../frontend/teams/index.js");

function makeFrontend(): ReturnType<typeof createTeamsFrontend> {
  const gateway = {
    setContext: vi.fn(),
    clearContext: vi.fn(),
    getMessageCount: vi.fn(() => 0),
    getPort: vi.fn(() => 19876),
    registerFrontendHandler: vi.fn(),
    start: vi.fn(async () => 19876),
    stop: vi.fn(async () => {}),
  };
  return createTeamsFrontend(
    { teamsWebhookUrl: "https://example.invalid/hook" } as never,
    gateway as never,
  );
}

describe("teams frontend lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("start() resolves once the poller is live", async () => {
    const frontend = makeFrontend();
    await frontend.init();

    let started = false;
    // A start() that never resolves would hang this test, which is the
    // regression: the boot await only came back at shutdown.
    await frontend.start().then(() => {
      started = true;
    });

    expect(started).toBe(true);
    expect(startPolling).toHaveBeenCalledWith(
      expect.anything(),
      "19:chat@thread.v2",
    );
  });

  it("start() rejects when the surface never came up", async () => {
    const frontend = makeFrontend();
    await expect(frontend.start()).rejects.toThrow(
      "Graph client not initialized",
    );
  });
});
