/**
 * Functional tests for the MCP launcher supervisor.
 *
 * Each test targets a distinct failure mode that would produce an orphaned
 * MCP subprocess in production. All spawn real Node subprocesses and tear
 * them down in afterEach — no mocks, no shortcuts. If these pass on Linux
 * and macOS, the "launcher-wrapped spawns never orphan" claim holds.
 *
 * Cases kept:
 *   1. SIGKILL of parent at scale (headline bug from PR #67).
 *   2. Graceful stdin-close shutdown (normal Talon exit).
 *   3. Stubborn child that ignores SIGTERM (validates SIGKILL fallback).
 *   4. Supervised child exits on its own (launcher doesn't hang).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LAUNCHER_MODULE = pathToFileURL(
  resolve(REPO_ROOT, "src/util/mcp-launcher.ts"),
).href;
const TSX_IMPORT = pathToFileURL(
  resolve(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs"),
).href;
const FUNCTIONAL_TIMEOUT_MS = 30_000;

// ── Helpers ────────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: exists but unreachable. Count as alive.
    return true;
  }
}

async function waitForPidGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
}

async function assertAllGone(pids: number[], timeoutMs: number): Promise<void> {
  const stuck: number[] = [];
  for (const pid of pids) {
    if (!(await waitForPidGone(pid, timeoutMs))) stuck.push(pid);
  }
  if (stuck.length > 0) {
    // Clean up the leak so it doesn't poison sibling tests.
    for (const pid of stuck) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ok */
      }
    }
    throw new Error(`orphaned pids after teardown: ${stuck.join(", ")}`);
  }
}

/** Read the first stdout line matching `match`, with a timeout. */
async function readMarker(
  child: ChildProcess,
  match: RegExp,
  timeoutMs: number,
  label: string,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${label}`)),
      timeoutMs,
    );
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(match);
      if (m) {
        clearTimeout(timer);
        child.stdout!.off("data", onData);
        resolve(m);
      }
    };
    child.stdout!.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited before ${label} (code=${code})`));
    });
  });
}

type IdlerOpts = {
  name?: string;
  /** If false, the idler keeps running even after its stdin closes. */
  exitOnStdinClose?: boolean;
  /** If true, the idler ignores SIGTERM (forces SIGKILL cleanup path). */
  ignoreSigterm?: boolean;
  /** If set, the idler exits on its own this many ms after starting. */
  selfExitAfterMs?: number;
};

function writeIdler(dir: string, opts: IdlerOpts = {}): string {
  const path = join(dir, opts.name ?? "idler.mjs");
  const exitOnStdin = opts.exitOnStdinClose !== false;
  const ignoreTerm = opts.ignoreSigterm === true;
  const selfExit = opts.selfExitAfterMs;
  writeFileSync(
    path,
    `
    process.stderr.write("IDLER_PID=" + process.pid + "\\n");
    ${exitOnStdin ? 'process.stdin.on("end", () => process.exit(0));' : ""}
    process.on("SIGTERM", () => { ${
      ignoreTerm ? "/* stubborn: ignore */" : "process.exit(0);"
    } });
    process.on("SIGINT", () => process.exit(0));
    process.stdin.resume();
    ${selfExit !== undefined ? `setTimeout(() => process.exit(0), ${selfExit});` : ""}
    setInterval(() => {}, 1 << 30);
    `,
  );
  return path;
}

type HarnessResult = { harness: ChildProcess; pids: number[] };

/**
 * Spawn a harness that uses the real `wrapMcpServer()` to supervise
 * `count` idlers. Resolves once every idler has reported its PID, returning
 * [launcher PIDs..., idler PIDs...] (length = count * 2).
 */
async function spawnHarness(opts: {
  workDir: string;
  count: number;
  idlerPath: string;
}): Promise<HarnessResult> {
  const { workDir, count, idlerPath } = opts;
  const harnessPath = join(workDir, "harness.mjs");
  writeFileSync(
    harnessPath,
    `
    import { spawn } from "node:child_process";
    import { wrapMcpServer } from ${JSON.stringify(LAUNCHER_MODULE)};

    const launchers = [];
    const idlers = [];
    const TARGET = ${count};

    for (let i = 0; i < TARGET; i++) {
      const cfg = wrapMcpServer({
        command: "node",
        args: [${JSON.stringify(idlerPath)}],
        env: {},
      });
      const c = spawn(cfg.command, cfg.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...cfg.env },
      });
      launchers.push(c);

      let buf = "";
      c.stderr.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/IDLER_PID=(\\d+)/);
        if (m) {
          idlers.push(parseInt(m[1], 10));
          buf = buf.replace(/IDLER_PID=\\d+\\n?/, "");
          if (idlers.length === TARGET) {
            process.stdout.write(
              "PIDS=" + launchers.map((c) => c.pid).concat(idlers).join(",") + "\\n",
            );
          }
        }
      });
    }

    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
    `,
  );

  const harness = spawn("node", ["--import", TSX_IMPORT, harnessPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: workDir },
  });
  const marker = await readMarker(
    harness,
    /PIDS=([\d,]+)/,
    15_000,
    "harness PID marker",
  );
  const pids = marker[1].split(",").map((s) => parseInt(s, 10));
  if (pids.length !== count * 2) {
    throw new Error(
      `harness reported ${pids.length} pids, expected ${count * 2}`,
    );
  }
  return { harness, pids };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("launcher functional: no orphaned MCP processes", () => {
  let workDir: string;
  const cleanup: Array<() => void> = [];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "talon-launcher-fn-"));
    process.env.HOME = workDir; // paths.ts reads homedir() → this
  });

  afterEach(() => {
    for (const fn of cleanup.splice(0)) {
      try {
        fn();
      } catch {
        /* ok */
      }
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  });

  function track(child: ChildProcess): void {
    cleanup.push(() => {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ok */
        }
      }
    });
  }

  it(
    "SIGKILL of parent cleans up every descendant (10 wrapped children)",
    async () => {
      const idler = writeIdler(workDir);
      const { harness, pids } = await spawnHarness({
        workDir,
        count: 10,
        idlerPath: idler,
      });
      track(harness);
      expect(pids).toHaveLength(20); // 10 launchers + 10 idlers

      harness.kill("SIGKILL");
      await assertAllGone(pids, 5_000);
    },
    FUNCTIONAL_TIMEOUT_MS,
  );

  it(
    "graceful shutdown (stdin close) cleans up every descendant",
    async () => {
      const idler = writeIdler(workDir);
      const { harness, pids } = await spawnHarness({
        workDir,
        count: 3,
        idlerPath: idler,
      });
      track(harness);

      harness.stdin!.end();
      const exitCode = await new Promise<number | null>((r) =>
        harness.on("exit", (c) => r(c)),
      );
      expect(exitCode).toBe(0);
      await assertAllGone(pids, 5_000);
    },
    FUNCTIONAL_TIMEOUT_MS,
  );

  it(
    "SIGKILLs stubborn children that ignore SIGTERM",
    async () => {
      const stubborn = writeIdler(workDir, {
        name: "stubborn.mjs",
        ignoreSigterm: true,
        exitOnStdinClose: false,
      });
      const { harness, pids } = await spawnHarness({
        workDir,
        count: 2,
        idlerPath: stubborn,
      });
      track(harness);

      harness.kill("SIGKILL");
      // Launcher: SIGTERM → 1s grace → SIGKILL. Give 4s headroom.
      await assertAllGone(pids, 4_000);
    },
    FUNCTIONAL_TIMEOUT_MS,
  );

  it(
    "launcher exits when its supervised child exits on its own",
    async () => {
      const oneShot = writeIdler(workDir, {
        name: "one-shot.mjs",
        selfExitAfterMs: 200,
      });
      const { harness, pids } = await spawnHarness({
        workDir,
        count: 1,
        idlerPath: oneShot,
      });
      track(harness);

      // Both launcher (pids[0]) and idler (pids[1]) must be gone within seconds
      // even though the harness itself is still running.
      await assertAllGone(pids, 5_000);
      expect(pidAlive(harness.pid!)).toBe(true);
    },
    FUNCTIONAL_TIMEOUT_MS,
  );
});
