/**
 * On-demand pairing: the core broker seam, the auth-dir lock, and the
 * no-auto-codes contract.
 *
 * Context: automatic re-pairing (even with a 30-minute backoff ladder)
 * burned pairing codes until WhatsApp rate-limited the account and every
 * scan failed with "couldn't connect device". Pairing is now strictly a
 * human act — one bounded attempt per /whatsapp pair — so the invariants
 * here are about who may pair, when, and that nothing pairs by itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  getPairingProvider,
  registerPairingProvider,
  type PairingProvider,
} from "../core/pairing-broker.js";
import {
  acquireManualPairing,
  releaseManualPairing,
  isManualPairingActive,
  onPairingComplete,
  resetPairingLock,
} from "../frontend/whatsapp/pairing-lock.js";

beforeEach(() => resetPairingLock());
afterEach(() => registerPairingProvider(null));

describe("pairing broker", () => {
  it("hands the registered provider to consumers and clears on null", () => {
    expect(getPairingProvider()).toBeNull();
    const p: PairingProvider = {
      label: "WhatsApp",
      isLinked: () => false,
      begin: async () => {
        throw new Error("unused");
      },
    };
    registerPairingProvider(p);
    expect(getPairingProvider()).toBe(p);
    registerPairingProvider(null);
    expect(getPairingProvider()).toBeNull();
  });
});

describe("manual pairing lock", () => {
  it("admits exactly one attempt at a time", () => {
    expect(acquireManualPairing()).toBe(true);
    expect(acquireManualPairing()).toBe(false); // second attempt refused
    expect(isManualPairingActive()).toBe(true);
    releaseManualPairing(false);
    expect(isManualPairingActive()).toBe(false);
    expect(acquireManualPairing()).toBe(true);
  });

  it("fires completion callbacks only on a successful pairing", () => {
    const fired: boolean[] = [];
    onPairingComplete(() => fired.push(true));

    acquireManualPairing();
    releaseManualPairing(false); // expired/cancelled — parked loops stay parked
    expect(fired).toHaveLength(0);

    acquireManualPairing();
    releaseManualPairing(true); // paired — parked loops wake immediately
    expect(fired).toHaveLength(1);
  });

  it("unsubscribe stops delivery", () => {
    const fired: boolean[] = [];
    const off = onPairingComplete(() => fired.push(true));
    off();
    acquireManualPairing();
    releaseManualPairing(true);
    expect(fired).toHaveLength(0);
  });
});

describe("the frontend never requests pairing codes on its own", () => {
  it("has no requestPairingCode call outside the on-demand service", async () => {
    // The regression this guards: index.ts once requested a fresh code on
    // every unregistered QR event — ~30 codes in 80 minutes, account
    // rate-limited. The only legitimate caller is the human-triggered
    // pairing service.
    const { readFileSync } = await import("node:fs");
    const frontendSrc = readFileSync(
      new URL("../frontend/whatsapp/index.ts", import.meta.url),
      "utf-8",
    );
    expect(frontendSrc).not.toContain("requestPairingCode");
  });
});
