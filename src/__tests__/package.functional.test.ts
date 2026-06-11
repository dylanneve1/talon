import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// 8 minutes — Windows runners regularly take 4+ minutes for `npm install`
// on the published tarball (cold cache + Windows fs latency); 240s was at
// the cliff (multiple 256–258s runs killing it). Bumped from 240k after
// repeated Windows-only flakes on PR #208 (runs 26037452792, 26038493696,
// 26038706000).
const FUNCTIONAL_TIMEOUT_MS = 480_000;
const NPM_CLI = process.env.npm_execpath;

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const workDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

function makeWorkDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `talon-${name}-`));
  workDirs.push(dir);
  return dir;
}

function childEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TALON_QUIET: "1",
    NO_COLOR: "1",
    // Pin daemon discovery to a port nothing's listening on so a
    // co-tenant Talon daemon (e.g. the developer's running prod bot on
    // 19876, or on a fallback port up to 19881) doesn't get reported as
    // the test's own running instance. HOME isolation already hides the
    // co-tenant's pidfile; this hides its gateway.
    TALON_HEALTH_PORT: "59876",
  };
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: boolean;
  } = {},
): RunResult {
  const child = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30_000,
    windowsHide: true,
    shell: options.shell ?? false,
  });

  return {
    code: child.status,
    stdout: child.stdout ?? "",
    stderr: child.error
      ? `${child.stderr ?? ""}\n${child.error.message}`
      : (child.stderr ?? ""),
  };
}

function runNpm(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): RunResult {
  if (NPM_CLI) return run(process.execPath, [NPM_CLI, ...args], options);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function expectOk(result: RunResult): void {
  expectExitOk(result);
  expect(
    result.stderr,
    `process exited with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe("");
}

function expectExitOk(result: RunResult): void {
  expect(
    result.stderr,
    `process exited with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).not.toContain("spawnSync");
  expect(result.code).toBe(0);
}

function packInto(dir: string): string {
  const result = runNpm(["pack", "--json", "--pack-destination", dir], {
    timeoutMs: 30_000,
  });
  expectOk(result);

  const entries = JSON.parse(result.stdout) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  const pack = entries[0];
  expect(pack).toBeDefined();

  const packedFiles = new Set(pack.files.map((file) => file.path));
  for (const required of [
    "bin/talon.js",
    "src/cli.ts",
    "src/util/mcp-launcher.mjs",
    "prompts/base.md",
    "tsconfig.json",
  ]) {
    expect(packedFiles.has(required), `${required} should be packed`).toBe(
      true,
    );
  }

  return join(dir, pack.filename);
}

describe("package functional smoke tests", () => {
  it(
    "published tarball includes runtime assets and exposes a working CLI",
    () => {
      const packDir = makeWorkDir("pack");
      const installDir = makeWorkDir("install");
      const homeDir = makeWorkDir("home");
      const tarball = packInto(packDir);

      writeFileSync(join(installDir, "package.json"), "{}\n");
      expectExitOk(
        runNpm(
          ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
          {
            cwd: installDir,
            timeoutMs: FUNCTIONAL_TIMEOUT_MS,
          },
        ),
      );

      const cli = join(
        installDir,
        "node_modules",
        "talon-agent",
        "bin",
        "talon.js",
      );
      const help = run(process.execPath, [cli, "--help"], {
        cwd: installDir,
        env: childEnv(homeDir),
      });

      expectOk(help);
      expect(help.stdout).toContain("Usage: talon [command]");
      expect(help.stdout).toContain("doctor");
    },
    FUNCTIONAL_TIMEOUT_MS,
  );

  it("source CLI status command is non-interactive and isolated from the real home directory", () => {
    const homeDir = makeWorkDir("source-home");
    const result = run(process.execPath, ["bin/talon.js", "status"], {
      env: childEnv(homeDir),
    });

    expectOk(result);
    expect(result.stdout).toContain("Stopped");
    expect(result.stdout).toContain("Run talon setup");
  });
});
