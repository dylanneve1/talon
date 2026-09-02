/**
 * Baileys logs through its own pino instance, far too chatty for a daemon
 * that already has structured logging. Bridge warn+ into Talon's log and
 * drop the rest. The shape is pino's minimal logger contract.
 *
 * Shared by the frontend socket (index.ts) and the manual pairing socket
 * (pairing-service.ts).
 */

import { logError, logWarn } from "../../util/log.js";

export function makeWaLogger(): never {
  const fmt = (args: unknown[]): string =>
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")
      .slice(0, 300);
  const shim = {
    level: "warn",
    child: () => shim,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => logWarn("whatsapp", `baileys: ${fmt(args)}`),
    error: (...args: unknown[]) =>
      logError("whatsapp", `baileys: ${fmt(args)}`),
    fatal: (...args: unknown[]) =>
      logError("whatsapp", `baileys: ${fmt(args)}`),
  };
  return shim as never;
}
