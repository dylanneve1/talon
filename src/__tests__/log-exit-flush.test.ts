/**
 * Shutdown lines must reach the file, because they are the only record
 * of why a daemon stopped.
 *
 * Incident 2026-09-18: every terminal log line Talon writes is followed
 * immediately by `process.exit()` — "State saved", "Respawn child
 * started", "Timeout exceeded, forcing exit", "Fatal startup error".
 * The file sink was a `createWriteStream`, which buffers in userspace
 * and drains on a later tick; `process.exit()` discards whatever is
 * queued. So a `/update` logged "Respawn requested", handed off, and
 * everything after that — including the successor's pid — was thrown
 * away with the buffer. Measured under Bun 1.3.9 against the old sink:
 * three lines then exit produced a log file that was never even created.
 *
 * This spawns a real child on the real runtime, because the bug only
 * exists in a process that actually exits.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunRuntime } from "../util/runtime.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG_MODULE = resolve(REPO_ROOT, "src/util/log.ts");
const TSX_CLI = resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The shutdown tail, compressed: log, log, log, exit. */
const CHILD = `
import { log } from ${JSON.stringify(LOG_MODULE)};
log("shutdown", "SIGTERM received, shutting down gracefully...");
log("shutdown", "State saved");
log("shutdown", "Respawn child started (pid 4242)");
process.exit(0);
`;

describe("log lines survive process.exit", () => {
  it("writes every line before the process goes away", () => {
    const home = mkdtempSync(resolve(tmpdir(), "talon-exit-flush-"));
    dirs.push(home);
    const script = resolve(home, "dying-daemon.ts");
    writeFileSync(script, CHILD);

    const args = isBunRuntime() ? [script] : [TSX_CLI, script];
    const run = spawnSync(process.execPath, args, {
      encoding: "utf-8",
      env: {
        ...process.env,
        TALON_HOME: home,
        TALON_QUIET: "1",
        // log.ts skips the file sink under vitest; this child is the
        // daemon, not the suite.
        VITEST: "",
      },
    });

    expect(run.status).toBe(0);
    const written = readFileSync(resolve(home, "talon.log"), "utf-8");
    expect(written).toContain("SIGTERM received");
    expect(written).toContain("State saved");
    // The line that names the successor is the last thing the old sink
    // ever dropped, and the one an operator needs most.
    expect(written).toContain("Respawn child started (pid 4242)");
  });
});
