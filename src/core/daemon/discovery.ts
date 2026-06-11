/**
 * Daemon instance discovery — find the running Talon daemon without
 * trusting the pidfile alone.
 *
 * Strategy (cross-platform: HTTP + signal-0 probes, no `ps` parsing):
 *   1. Read the pidfile. If it records a gateway port, probe that
 *      port's /health and verify identity (`app: "talon"`,
 *      `mode: "daemon"`, matching pid).
 *   2. If the pidfile is missing, stale, or portless, scan the
 *      gateway's EADDRINUSE fallback range and identity-match — this
 *      recovers daemons whose pidfile was lost (the pre-fix /restart
 *      handoff bug left exactly that state behind).
 *
 * The identity check distinguishes the daemon from a `talon chat`
 * session (which also runs a gateway, mode "chat") and from unrelated
 * localhost services.
 */

import { readPidRecord, isProcessAlive } from "./pidfile.js";

export type DaemonHealth = {
  app?: string;
  mode?: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  ok?: boolean;
  uptime?: number;
  memory?: number;
  sessions?: number;
  messages?: number;
  queue?: number;
  errors?: number;
  lastActivity?: string;
  [key: string]: unknown;
};

export type RunningInstance = {
  pid: number;
  port?: number;
  health?: DaemonHealth;
  /**
   * How the instance was found:
   *   - "pidfile": pidfile pid confirmed (via health or liveness+scan)
   *   - "scan": found via port scan; the pidfile was absent or pointed
   *     at a different/dead process
   *   - "pidfile-unverified": pidfile pid is alive but no health
   *     endpoint answered (daemon still booting, or a pre-identity
   *     version)
   */
  source: "pidfile" | "scan" | "pidfile-unverified";
  /** True when the pidfile is missing or disagrees with the live daemon. */
  pidfileStale: boolean;
};

export const GATEWAY_BASE_PORT = 19876;
/** gateway.start() retries port+1 up to 5 times on EADDRINUSE. */
export const GATEWAY_PORT_RANGE = 6;

/**
 * Ports to probe for a daemon gateway. TALON_HEALTH_PORT pins the scan
 * to a single port — tests use it to isolate from a co-tenant daemon.
 */
export function candidateGatewayPorts(): number[] {
  const override = process.env.TALON_HEALTH_PORT;
  if (override) {
    const p = parseInt(override, 10);
    return Number.isInteger(p) && p > 0 ? [p] : [];
  }
  return Array.from(
    { length: GATEWAY_PORT_RANGE },
    (_, i) => GATEWAY_BASE_PORT + i,
  );
}

export async function probeHealth(
  port: number,
  timeoutMs = 800,
): Promise<DaemonHealth | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as DaemonHealth;
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

function isDaemonHealth(h: DaemonHealth | null): h is DaemonHealth {
  return (
    h !== null &&
    h.app === "talon" &&
    h.mode === "daemon" &&
    typeof h.pid === "number"
  );
}

async function scanForDaemon(): Promise<RunningInstance | null> {
  const ports = candidateGatewayPorts();
  const probes = await Promise.all(
    ports.map(async (port) => ({ port, health: await probeHealth(port) })),
  );
  for (const { port, health } of probes) {
    if (isDaemonHealth(health)) {
      return {
        pid: health.pid as number,
        port,
        health,
        source: "scan",
        pidfileStale: true,
      };
    }
  }
  return null;
}

export async function findRunningInstance(
  pidfilePath?: string,
): Promise<RunningInstance | null> {
  const record = readPidRecord(pidfilePath);

  if (record) {
    if (record.port) {
      const health = await probeHealth(record.port);
      if (isDaemonHealth(health)) {
        const stale = health.pid !== record.pid;
        return {
          pid: health.pid as number,
          port: record.port,
          health,
          source: stale ? "scan" : "pidfile",
          pidfileStale: stale,
        };
      }
      // A /health answered but without identity fields — a pre-identity
      // daemon. Trust it if the recorded pid is alive.
      if (health && isProcessAlive(record.pid)) {
        return {
          pid: record.pid,
          port: record.port,
          health,
          source: "pidfile",
          pidfileStale: false,
        };
      }
    }
    if (isProcessAlive(record.pid)) {
      // Alive but unconfirmed via its recorded port (booting, legacy
      // version, or the port was taken over) — try the scan range.
      const scanned = await scanForDaemon();
      if (scanned?.pid === record.pid) {
        return { ...scanned, source: "pidfile", pidfileStale: false };
      }
      if (scanned) return scanned; // live daemon beats a stale pidfile
      return {
        pid: record.pid,
        port: record.port,
        source: "pidfile-unverified",
        pidfileStale: false,
      };
    }
    // Recorded pid is dead — stale file; fall through to the scan.
  }

  return scanForDaemon();
}
