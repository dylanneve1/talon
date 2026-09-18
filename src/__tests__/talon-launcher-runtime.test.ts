/**
 * bin/talon.js runtime preference: started by Node with a `bun` on PATH it
 * re-execs itself under Bun; TALON_RUNTIME=node pins Node; without a bun it
 * runs on Node as before.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

const LAUNCHER = resolve(import.meta.dirname, "..", "..", "bin", "talon.js");
const NODE_DIR = resolve(process.execPath, "..");

let shimDir: string;

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "talon-bun-shim-"));
  // A fake `bun` that records how it was invoked instead of running Talon.
  const shim = join(shimDir, "bun");
  writeFileSync(shim, '#!/bin/sh\necho "BUN-SHIM $*"\nexit 0\n');
  chmodSync(shim, 0o755);
});

afterAll(() => {
  rmSync(shimDir, { recursive: true, force: true });
});

function runLauncher(
  args: string[],
  pathDirs: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: pathDirs.join(delimiter),
      TALON_RUNTIME: "",
      ...extraEnv,
    },
    timeout: 60_000,
  });
}

const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("bin/talon.js runtime preference", () => {
  it("re-execs under a bun found on PATH, forwarding the arguments", () => {
    const result = runLauncher(["status", "--json"], [shimDir, NODE_DIR]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`BUN-SHIM ${LAUNCHER} status --json`);
  });

  it("stays on Node when TALON_RUNTIME=node even with a bun on PATH", () => {
    const result = runLauncher(["--version"], [shimDir, NODE_DIR], {
      TALON_RUNTIME: "node",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("BUN-SHIM");
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("runs on Node when no bun is on PATH", () => {
    const result = runLauncher(["--version"], [NODE_DIR]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("BUN-SHIM");
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
