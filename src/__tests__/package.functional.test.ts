import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
// 15 minutes — Windows runners regularly take 4+ minutes for `npm install`
// on the published tarball (cold cache + Windows fs latency); 240s was at
// the cliff (multiple 256–258s runs killing it). Bumped from 240k after
// repeated Windows-only flakes on PR #208 (runs 26037452792, 26038493696,
// 26038706000). Bumped again from 480k on PR #500: the mem0ai dependency
// (which vendors its own openai SDK copy) pushed Windows installs past
// 480s on four consecutive runs (e.g. run 29102329726). The Functional CI
// job allows 25 minutes, so 15 here still leaves headroom.
const FUNCTIONAL_TIMEOUT_MS = 900_000;
const NPM_CLI = process.env.npm_execpath;

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const workDirs: string[] = [];

afterEach(() => {
  for (const dir of workDirs.splice(0)) {
    // Windows: removing an npm-installed tree can hit transient EBUSY
    // and take minutes — retry and give the hook real headroom.
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}, 180_000);

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
  const detail = `process exited with ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  expect(result.stderr, detail).not.toContain("spawnSync");
  // Attach the child's output to the exit-code assertion too — otherwise a
  // non-zero exit reports only "expected 1 to be +0" and the actual npm/CLI
  // error is unrecoverable from the CI log.
  expect(result.code, detail).toBe(0);
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
    "src/app.ts",
    "src/cli.ts",
    "src/util/mcp-launcher.ts",
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
      // --prefer-offline: the job's earlier `npm ci` warmed the runner's
      // npm cache with this exact dependency tree — skip the per-package
      // registry staleness checks that pushed Windows installs past even
      // the 15-minute ceiling (run 29149502496 ETIMEDOUT at 900s after
      // three successive timeout bumps; stop the arms race at the cause).
      const installArgs = (freshness: string) => [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        freshness,
        "--no-progress",
        tarball,
      ];
      let install = runNpm(installArgs("--prefer-offline"), {
        cwd: installDir,
        timeoutMs: FUNCTIONAL_TIMEOUT_MS,
      });
      // Stale-cache escape hatch: a restored CI cache can hold
      // mixed-freshness registry metadata after an upstream publish — a
      // fresh packument resolves a version whose own dependencies aren't in
      // the cached packuments yet, and --prefer-offline never revalidates,
      // so npm fails with ETARGET "No matching version found" on every
      // rerun (run 29479512086: @openai/codex-sdk@0.144.5 resolved from
      // fresh metadata, its dep @openai/codex@0.144.5 missing from the
      // cached one). Retry once with --prefer-online, which revalidates
      // metadata but still serves warmed tarballs from the cache.
      if (install.code !== 0 && /notarget|ETARGET/i.test(install.stderr)) {
        install = runNpm(installArgs("--prefer-online"), {
          cwd: installDir,
          timeoutMs: FUNCTIONAL_TIMEOUT_MS,
        });
      }
      expectExitOk(install);

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
