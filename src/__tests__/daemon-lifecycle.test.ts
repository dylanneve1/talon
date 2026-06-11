/**
 * Daemon lifecycle — pidfile ownership, instance discovery, stop/start
 * orchestration.
 *
 * The regression these guard against: a Telegram /restart handoff
 * (util/respawn.ts) where the dying parent's shutdown deleted the
 * successor's freshly-written pidfile, leaving a live daemon untracked
 * — so the next `talon restart` reported "not running" and spawned a
 * duplicate that fought the original over Telegram's getUpdates.
 *
 * Tests use a real tmpdir pidfile and real HTTP stubs on ephemeral
 * ports — the discovery layer is exactly the HTTP+signal surface we
 * want exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readPidRecord,
  writePidRecord,
  removePidRecordIfOwnedBy,
  isProcessAlive,
} from "../core/daemon/pidfile.js";
import {
  candidateGatewayPorts,
  findRunningInstance,
  probeHealth,
  GATEWAY_BASE_PORT,
  GATEWAY_PORT_RANGE,
} from "../core/daemon/discovery.js";
import { stopDaemon } from "../core/daemon/control.js";

let workDir: string;
let pidfile: string;
const servers: Server[] = [];
const children: ChildProcess[] = [];
const envBackup = process.env.TALON_HEALTH_PORT;

/** A pid that is certainly not running (max pid on Linux is < 2^22). */
const DEAD_PID = 2 ** 30 + 1;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "talon-daemon-test-"));
  pidfile = join(workDir, "talon.pid");
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  if (envBackup === undefined) delete process.env.TALON_HEALTH_PORT;
  else process.env.TALON_HEALTH_PORT = envBackup;
});

function serveHealth(payload: unknown): Promise<number> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function daemonHealth(pid: number, extra: Record<string, unknown> = {}) {
  return {
    app: "talon",
    mode: "daemon",
    pid,
    ok: true,
    uptime: 42,
    ...extra,
  };
}

// ── pidfile ─────────────────────────────────────────────────────────────────

describe("pidfile", () => {
  it("round-trips a full record", () => {
    writePidRecord(
      { pid: 1234, port: 19876, startedAt: "2026-06-11T00:00:00.000Z" },
      pidfile,
    );
    expect(readPidRecord(pidfile)).toEqual({
      pid: 1234,
      port: 19876,
      startedAt: "2026-06-11T00:00:00.000Z",
    });
  });

  it("creates missing parent directories", () => {
    const nested = join(workDir, "deep", "nested", "talon.pid");
    writePidRecord({ pid: 7 }, nested);
    expect(readPidRecord(nested)).toEqual({ pid: 7 });
  });

  it("reads legacy bare-integer files", () => {
    writeFileSync(pidfile, "4242\n");
    expect(readPidRecord(pidfile)).toEqual({ pid: 4242 });
  });

  it("treats corrupt, empty, and missing files as absent", () => {
    expect(readPidRecord(pidfile)).toBeNull();
    writeFileSync(pidfile, "");
    expect(readPidRecord(pidfile)).toBeNull();
    writeFileSync(pidfile, "not json {{{");
    expect(readPidRecord(pidfile)).toBeNull();
    writeFileSync(pidfile, JSON.stringify({ port: 19876 })); // no pid
    expect(readPidRecord(pidfile)).toBeNull();
    writeFileSync(pidfile, JSON.stringify({ pid: -5 }));
    expect(readPidRecord(pidfile)).toBeNull();
  });

  it("removes the file only for the owning pid", () => {
    writePidRecord({ pid: 1111 }, pidfile);

    // A different pid (e.g. the dying parent in a /restart handoff)
    // must NOT remove the successor's record.
    expect(removePidRecordIfOwnedBy(2222, pidfile)).toBe(false);
    expect(readPidRecord(pidfile)).toEqual({ pid: 1111 });

    expect(removePidRecordIfOwnedBy(1111, pidfile)).toBe(true);
    expect(readPidRecord(pidfile)).toBeNull();
  });

  it("regression: /restart handoff — parent shutdown leaves successor record intact", () => {
    const parentPid = 1000;
    const successorPid = 2000;
    // Parent wrote its record at boot...
    writePidRecord({ pid: parentPid, port: 19876 }, pidfile);
    // ...successor overwrites it during the handoff...
    writePidRecord({ pid: successorPid, port: 19876 }, pidfile);
    // ...then the parent's graceful shutdown runs. The old code
    // unlinked unconditionally here, orphaning the successor.
    removePidRecordIfOwnedBy(parentPid, pidfile);
    expect(readPidRecord(pidfile)?.pid).toBe(successorPid);
  });

  it("isProcessAlive: own process alive, absurd pid dead", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});

// ── discovery ───────────────────────────────────────────────────────────────

describe("discovery", () => {
  it("candidate ports honour TALON_HEALTH_PORT, default to the fallback range", () => {
    delete process.env.TALON_HEALTH_PORT;
    const ports = candidateGatewayPorts();
    expect(ports).toHaveLength(GATEWAY_PORT_RANGE);
    expect(ports[0]).toBe(GATEWAY_BASE_PORT);
    expect(ports.at(-1)).toBe(GATEWAY_BASE_PORT + GATEWAY_PORT_RANGE - 1);

    process.env.TALON_HEALTH_PORT = "59123";
    expect(candidateGatewayPorts()).toEqual([59123]);

    process.env.TALON_HEALTH_PORT = "bogus";
    expect(candidateGatewayPorts()).toEqual([]);
  });

  it("probeHealth returns the payload, null on connection failure", async () => {
    const port = await serveHealth({ ok: true, app: "talon" });
    expect(await probeHealth(port)).toMatchObject({ ok: true, app: "talon" });
    // TCP port 9 (discard) — nothing listens there in practice.
    expect(await probeHealth(9, 300)).toBeNull();
  });

  it("finds the daemon via pidfile + recorded port", async () => {
    const port = await serveHealth(daemonHealth(process.pid, { port: 0 }));
    writePidRecord({ pid: process.pid, port }, pidfile);

    const inst = await findRunningInstance(pidfile);
    expect(inst).toMatchObject({
      pid: process.pid,
      port,
      source: "pidfile",
      pidfileStale: false,
    });
    expect(inst?.health?.app).toBe("talon");
  });

  it("reports a stale pidfile when health pid disagrees", async () => {
    const port = await serveHealth(daemonHealth(process.pid));
    writePidRecord({ pid: DEAD_PID, port }, pidfile);

    const inst = await findRunningInstance(pidfile);
    expect(inst).toMatchObject({ pid: process.pid, pidfileStale: true });
  });

  it("recovers a daemon with no pidfile via the port scan", async () => {
    const port = await serveHealth(daemonHealth(process.pid));
    process.env.TALON_HEALTH_PORT = String(port);

    const inst = await findRunningInstance(pidfile);
    expect(inst).toMatchObject({
      pid: process.pid,
      port,
      source: "scan",
      pidfileStale: true,
    });
  });

  it("does not mistake a `talon chat` gateway for the daemon", async () => {
    const port = await serveHealth(daemonHealth(process.pid, { mode: "chat" }));
    process.env.TALON_HEALTH_PORT = String(port);

    expect(await findRunningInstance(pidfile)).toBeNull();
  });

  it("does not mistake an unrelated localhost service for the daemon", async () => {
    const port = await serveHealth({ ok: true, status: "healthy" });
    process.env.TALON_HEALTH_PORT = String(port);

    expect(await findRunningInstance(pidfile)).toBeNull();
  });

  it("reports alive-but-unverified when the pid lives but no gateway answers", async () => {
    process.env.TALON_HEALTH_PORT = "59124"; // nothing listening
    writePidRecord({ pid: process.pid }, pidfile);

    const inst = await findRunningInstance(pidfile);
    expect(inst).toMatchObject({
      pid: process.pid,
      source: "pidfile-unverified",
      pidfileStale: false,
    });
  });

  it("returns null for a dead recorded pid and no live gateway", async () => {
    process.env.TALON_HEALTH_PORT = "59125";
    writePidRecord({ pid: DEAD_PID, port: 59125 }, pidfile);

    expect(await findRunningInstance(pidfile)).toBeNull();
  });
});

// ── control ─────────────────────────────────────────────────────────────────

describe("control.stopDaemon", () => {
  it("reports not-running and clears a stale pidfile", async () => {
    process.env.TALON_HEALTH_PORT = "59126";
    writePidRecord({ pid: DEAD_PID }, pidfile);

    const outcome = await stopDaemon({ pidfilePath: pidfile });
    expect(outcome).toEqual({ stopped: false, reason: "not-running" });
    expect(readPidRecord(pidfile)).toBeNull();
  });

  it("stops a real process gracefully via POST /shutdown", async () => {
    // A stand-in daemon: serves /health with daemon identity and exits
    // on POST /shutdown — mirroring the gateway contract.
    const { spawn } = await import("node:child_process");
    const script = join(workDir, "fake-daemon.mjs");
    writeFileSync(
      script,
      `
      import { createServer } from "node:http";
      const server = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ app: "talon", mode: "daemon", pid: process.pid, ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/shutdown") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          setImmediate(() => process.exit(0));
          return;
        }
        res.writeHead(404); res.end();
      });
      server.listen(0, "127.0.0.1", () => console.log((server.address()).port));
      `,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    children.push(child);
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (buf) => resolve(parseInt(String(buf), 10)));
      child.once("error", reject);
      child.once("exit", () => reject(new Error("fake daemon died early")));
    });
    writePidRecord({ pid: child.pid as number, port }, pidfile);

    const outcome = await stopDaemon({ pidfilePath: pidfile });
    expect(outcome).toEqual({
      stopped: true,
      pid: child.pid,
      method: "http",
    });
    expect(isProcessAlive(child.pid as number)).toBe(false);
    expect(readPidRecord(pidfile)).toBeNull();
  }, 15_000);
});

// ── pidfile format on disk ──────────────────────────────────────────────────

describe("pidfile on-disk format", () => {
  it("is single-line JSON parseable by external tools", () => {
    writePidRecord({ pid: 99, port: 19876, startedAt: "x" }, pidfile);
    const raw = readFileSync(pidfile, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ pid: 99, port: 19876 });
  });
});
