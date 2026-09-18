/**
 * The daemon control actions the companion app fires from Settings.
 *
 * Both are privileged-ish (restart the daemon, kick off a memory
 * consolidation), so the contract that matters is that each one answers
 * `{ ok, message }` — never throws, never blocks on the work it started —
 * and that an unrecognised action is refused by name rather than silently
 * doing something. The restart spawn and the dream run are stubbed; this
 * test must never restart anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../core/background/dream.js", () => ({ forceDream: vi.fn() }));

import { spawn } from "node:child_process";
import { forceDream } from "../core/background/dream.js";
import { control } from "../frontend/native/control.js";
import { logError } from "../util/log.js";
import { settle } from "./helpers/native-bridge.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("native bridge control", () => {
  it("restarts by spawning a detached successor that outlives this process", async () => {
    await expect(control("restart")).resolves.toMatchObject({ ok: true });
    expect(vi.mocked(spawn).mock.calls[0]![2]).toMatchObject({
      detached: true,
      stdio: "ignore",
    });
  });

  it("unrefs the successor so it is not tied to this process", async () => {
    const child = { unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);
    await control("restart");
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("starts a dream run without waiting for it to finish", async () => {
    vi.mocked(forceDream).mockReturnValue(new Promise(() => {}));
    await expect(control("dream")).resolves.toEqual({
      ok: true,
      message: "Dream started — consolidating memory.",
    });
  });

  it("reports a dream that is already running as a failure", async () => {
    vi.mocked(forceDream).mockImplementation(() => {
      throw new Error("A dream is already running");
    });
    await expect(control("dream")).resolves.toEqual({
      ok: false,
      message: "A dream is already running",
    });
  });

  it("logs a dream that fails later instead of leaving it unhandled", async () => {
    vi.mocked(forceDream).mockRejectedValue(new Error("no model"));
    await control("dream");
    await settle();

    expect(vi.mocked(logError)).toHaveBeenCalledWith(
      "native",
      "Manual dream run failed",
      expect.any(Error),
    );
  });

  it("names an action it does not know rather than throwing", async () => {
    await expect(control("self-destruct")).resolves.toEqual({
      ok: false,
      message: "Unknown control action: self-destruct",
    });
  });
});
