/**
 * WhatsApp pairing-recovery policy + the admin-notify seam.
 *
 * Regression context: when WhatsApp unlinked the device
 * (`device_removed`), the reconnect loop wiped auth and requested a new
 * pairing code every ~2½ minutes for 80 minutes — 26 codes, each
 * invalidating the last, all visible only in the daemon log. Nobody was
 * told, so the outage was unrecoverable by design. The policy below is
 * what the loop now follows; the notify seam is how the code reaches a
 * human over a frontend that still works.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  classifyClose,
  nextPairingDelayMs,
  shouldNotifyPairingCode,
  PAIRING_NOTIFY_FREE_CODES,
  PAIRING_NOTIFY_MIN_GAP_MS,
} from "../frontend/whatsapp/pairing.js";
import { notifyAdmin, setAdminNotifier } from "../core/notify.js";

afterEach(() => setAdminNotifier(null));

describe("pairing retry backoff", () => {
  it("retries the first cycle quickly, then spaces out to a 30-minute cap", () => {
    expect(nextPairingDelayMs(0)).toBe(0);
    expect(nextPairingDelayMs(1)).toBe(5_000);
    expect(nextPairingDelayMs(2)).toBe(5 * 60_000);
    expect(nextPairingDelayMs(3)).toBe(10 * 60_000);
    expect(nextPairingDelayMs(4)).toBe(20 * 60_000);
    expect(nextPairingDelayMs(5)).toBe(30 * 60_000);
    expect(nextPairingDelayMs(50)).toBe(30 * 60_000);
  });

  it("never regenerates codes at the old 2½-minute cadence past the first retries", () => {
    // The property that actually matters: after the free retries, every
    // gap is at least 5 minutes — the old loop's ~150s cadence is gone.
    for (let attempt = 2; attempt < 20; attempt++) {
      expect(nextPairingDelayMs(attempt)).toBeGreaterThanOrEqual(5 * 60_000);
    }
  });
});

describe("pairing notification throttle", () => {
  const now = Date.parse("2026-08-23T14:00:00Z");

  it("always notifies for the first few codes", () => {
    for (let n = 1; n <= PAIRING_NOTIFY_FREE_CODES; n++) {
      expect(shouldNotifyPairingCode(n, now - 1000, now)).toBe(true);
    }
  });

  it("then holds to at most one notification per hour", () => {
    const n = PAIRING_NOTIFY_FREE_CODES + 1;
    expect(shouldNotifyPairingCode(n, now - 10 * 60_000, now)).toBe(false);
    expect(
      shouldNotifyPairingCode(n, now - PAIRING_NOTIFY_MIN_GAP_MS, now),
    ).toBe(true);
  });

  it("notifies when it has never notified before", () => {
    expect(shouldNotifyPairingCode(99, undefined, now)).toBe(true);
  });
});

describe("admin notify seam", () => {
  it("delivers through the wired notifier", async () => {
    const delivered: string[] = [];
    setAdminNotifier(async (text) => {
      delivered.push(text);
    });
    expect(await notifyAdmin("code ABCD-1234")).toBe(true);
    expect(delivered).toEqual(["code ABCD-1234"]);
  });

  it("degrades to false when nothing is wired", async () => {
    expect(await notifyAdmin("nobody home")).toBe(false);
  });

  it("swallows delivery failures rather than throwing into the caller", async () => {
    setAdminNotifier(async () => {
      throw new Error("telegram down too");
    });
    await expect(notifyAdmin("x")).resolves.toBe(false);
  });
});

describe("close-code taxonomy", () => {
  it("reads 515 as pairing success, not an error", () => {
    // Entering a pairing code CLOSES the connection with restartRequired;
    // the old handler logged it as an anonymous failure and applied
    // reconnect backoff to the very reconnect that completes the login.
    expect(classifyClose(515, false)).toEqual({ kind: "pairing-accepted" });
    expect(classifyClose(515, true)).toEqual({ kind: "pairing-accepted" });
  });

  it("reads 440 as a session takeover to back off from", () => {
    expect(classifyClose(440, true)).toEqual({ kind: "replaced" });
  });

  it("distinguishes a killed session from an expired pairing attempt", () => {
    expect(classifyClose(401, true)).toEqual({
      kind: "logged-out",
      midPairing: false,
    });
    expect(classifyClose(401, false)).toEqual({
      kind: "logged-out",
      midPairing: true,
    });
    expect(classifyClose(403, true)).toEqual({
      kind: "logged-out",
      midPairing: false,
    });
  });

  it("treats everything else as transient", () => {
    for (const code of [408, 428, 500, 503, undefined]) {
      expect(classifyClose(code, true)).toEqual({ kind: "reconnect" });
    }
  });
});
