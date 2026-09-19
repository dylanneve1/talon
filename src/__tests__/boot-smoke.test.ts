/**
 * `--boot-smoke`: does the tree we are about to restart into import?
 *
 * `/update` runs `npm install`, which rewrites node_modules underneath
 * the live process. Nothing notices a bad resolution until the successor
 * imports the tree — detached, output going nowhere, at the one moment
 * the daemon has no one left to report to. On 2026-09-18 a successor
 * died at boot and the bot stayed down for 45 minutes.
 *
 * So the update runs the real entry with this flag first. It resolves
 * the daemon's entire import graph and exits before the first bootstrap
 * step: a clean exit means the successor will at least start.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBunRuntime } from "../util/runtime.js";
import { BOOT_SMOKE_FLAG, BOOT_SMOKE_OK } from "../core/daemon/respawn.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = resolve(REPO_ROOT, "src/index.ts");
const TSX_CLI = resolve(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("boot smoke", () => {
  it("imports the whole daemon graph and exits without booting", () => {
    const home = mkdtempSync(join(tmpdir(), "talon-boot-smoke-"));
    dirs.push(home);

    const args = isBunRuntime()
      ? [ENTRY, BOOT_SMOKE_FLAG]
      : [TSX_CLI, ENTRY, BOOT_SMOKE_FLAG];
    const run = spawnSync(process.execPath, args, {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TALON_HOME: home,
        TALON_DB_PATH: join(home, "smoke.db"),
        TALON_QUIET: "1",
        VITEST: "",
      },
    });

    expect(run.stdout).toContain(BOOT_SMOKE_OK);
    expect(run.status).toBe(0);
  }, 60_000);
});
