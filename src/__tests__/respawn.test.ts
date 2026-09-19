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
 *
 * Incident 2026-09-18: a successor was spawned with stdio "ignore",
 * lived ~20s, never bound its gateway and died — leaving no line in any
 * file, on any process, and the bot down for 45 minutes. So the handoff
 * also has to (a) give the successor a file to die into and (b) leave
 * behind a witness that outlives the process doing the handing off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const openRespawnLogMock = vi.hoisted(() => vi.fn(() => 17));

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  openRespawnLog: openRespawnLogMock,
}));

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: 4242, once: vi.fn(), unref: vi.fn() });
  openRespawnLogMock.mockReset();
  openRespawnLogMock.mockReturnValue(17);
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(() => {
  killSpy.mockRestore();
});

describe("respawn handoff ordering", () => {
  it("arms without spawning, and signals itself to shut down", async () => {
    const { respawnSelf, respawnRequested } =
      await import("../core/daemon/respawn.js");

    expect(respawnRequested()).toBe(false);
    respawnSelf("telegram /restart");

    // The successor must NOT exist yet — the frontends are still up.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(respawnRequested()).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("spawns the successor only once shutdown calls spawnSuccessor", async () => {
    const { respawnSelf, spawnSuccessor } =
      await import("../core/daemon/respawn.js");

    respawnSelf("telegram /restart");
    expect(spawnMock).not.toHaveBeenCalled();

    spawnSuccessor();
    // The successor, then its witness.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[0]![0]).toBe(process.argv[0]);
  });

  it("sends the successor's stdout and stderr to respawn.log", async () => {
    const { respawnSelf, spawnSuccessor } =
      await import("../core/daemon/respawn.js");

    respawnSelf("telegram /update");
    spawnSuccessor();

    const opts = spawnMock.mock.calls[0]![2] as {
      stdio: unknown[];
      detached: boolean;
    };
    // stdin stays closed; both output streams land in the file, so a
    // successor that dies before its own logger exists still says why.
    expect(opts.stdio).toEqual(["ignore", 17, 17]);
    expect(opts.detached).toBe(true);
  });

  it("arms a watcher on the successor's pid, sharing that log", async () => {
    const { respawnSelf, spawnSuccessor } =
      await import("../core/daemon/respawn.js");
    const { HANDOFF_WATCH_SUBCOMMAND } =
      await import("../core/daemon/handoff.js");

    respawnSelf("telegram /update");
    spawnSuccessor();

    const [cmd, args, opts] = spawnMock.mock.calls[1]! as [
      string,
      string[],
      { stdio: unknown[]; detached: boolean },
    ];
    expect(cmd).toBe(process.argv[0]);
    expect(args.slice(-2)).toEqual([HANDOFF_WATCH_SUBCOMMAND, "4242"]);
    expect(args).toContain(process.argv[1]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", 17, 17]);
  });

  it("still hands off when respawn.log cannot be opened", async () => {
    const { respawnSelf, spawnSuccessor } =
      await import("../core/daemon/respawn.js");
    openRespawnLogMock.mockReturnValue(null as unknown as number);

    respawnSelf("telegram /restart");
    spawnSuccessor();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const opts = spawnMock.mock.calls[0]![2] as { stdio: unknown[] };
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("does not spawn on a plain shutdown that never armed a respawn", async () => {
    const { spawnSuccessor } = await import("../core/daemon/respawn.js");

    spawnSuccessor();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("hands off at most once", async () => {
    const { respawnSelf, spawnSuccessor, respawnRequested } =
      await import("../core/daemon/respawn.js");

    respawnSelf("telegram /update");
    spawnSuccessor();
    spawnSuccessor();

    // One successor and one watcher, not two of each.
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(respawnRequested()).toBe(false);
  });

  it("never throws when the successor cannot be spawned", async () => {
    const { respawnSelf, spawnSuccessor } =
      await import("../core/daemon/respawn.js");
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN");
    });

    respawnSelf("telegram /restart");
    // A failed handoff must still let this process exit.
    expect(() => spawnSuccessor()).not.toThrow();
  });
});
