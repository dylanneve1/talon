/**
 * Respawn handoff ordering.
 *
 * Regression: `respawnSelf()` used to spawn the successor immediately
 * and only then raise SIGTERM. Graceful shutdown drains in-flight
 * queries (up to DRAIN_TIMEOUT_MS) before stopping the frontends, so
 * the successor was long-polling `getUpdates` while the outgoing
 * process still held the poll. Telegram answers one poller and
 * re-delivers the unconfirmed updates to the other — a restart
 * mid-turn logged a 409 Conflict on the way out and produced
 * duplicate replies on the way in.
 *
 * The contract now: arming must not spawn. Only `spawnSuccessor()` —
 * called at the tail of shutdown, after the frontends have stopped —
 * may start the successor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, once: vi.fn(), unref: vi.fn() });
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
});

describe("respawn handoff ordering", () => {
  it("arms without spawning, and signals itself to shut down", async () => {
    const { respawnSelf, respawnRequested } =
      await import("../util/respawn.js");

    expect(respawnRequested()).toBe(false);
    respawnSelf("telegram /restart");

    // The successor must NOT exist yet — the frontends are still up.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(respawnRequested()).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("spawns the successor only once shutdown calls spawnSuccessor", async () => {
    const { respawnSelf, spawnSuccessor } = await import("../util/respawn.js");

    respawnSelf("telegram /restart");
    expect(spawnMock).not.toHaveBeenCalled();

    spawnSuccessor();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toBe(process.argv[0]);
  });

  it("does not spawn on a plain shutdown that never armed a respawn", async () => {
    const { spawnSuccessor } = await import("../util/respawn.js");

    spawnSuccessor();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("hands off at most once", async () => {
    const { respawnSelf, spawnSuccessor, respawnRequested } =
      await import("../util/respawn.js");

    respawnSelf("telegram /update");
    spawnSuccessor();
    spawnSuccessor();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(respawnRequested()).toBe(false);
  });

  it("never throws when the successor cannot be spawned", async () => {
    const { respawnSelf, spawnSuccessor } = await import("../util/respawn.js");
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });

    respawnSelf("telegram /restart");
    // A failed handoff must still let this process exit.
    expect(() => spawnSuccessor()).not.toThrow();
  });
});
