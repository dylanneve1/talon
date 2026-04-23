import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  PLAYWRIGHT_MCP_VERSION,
  SUPPORTED_BROWSERS,
  createPlaywrightHeal,
  detectInstalledMcpVersion,
} from "../../plugins/playwright/heal.js";
import { createProgressLogger } from "../../plugins/common/progress.js";

/**
 * Heal tests target:
 *   - pin enforcement (installed ≠ pinned is a fatal fail — we cannot
 *     safely mutate node_modules at runtime, so the only sane response
 *     is to tell the user to run `npm install`)
 *   - browser install decision tree (skip when already installed,
 *     actually install when missing, classify failures correctly)
 *   - remote-endpoint mode (no browser touched — heal completes on CLI
 *     check alone)
 */

type ResponseSpec = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
};

interface ScriptEntry {
  match: (cmd: string, args: readonly string[]) => boolean;
  response: ResponseSpec;
}

function scriptedSpawn(script: ScriptEntry[]) {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const impl = (
    cmd: string,
    args: readonly string[],
    _opts: SpawnOptions,
  ): ChildProcess => {
    calls.push({ cmd, args });
    const idx = script.findIndex((c) => c.match(cmd, args));
    if (idx === -1) {
      throw new Error(`no scripted response for: ${cmd} ${args.join(" ")}`);
    }
    const { response } = script.splice(idx, 1)[0];
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (response.spawnError) child.emit("error", response.spawnError);
      if (response.stdout) child.stdout.write(response.stdout);
      if (response.stderr) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", response.exitCode ?? 0, null);
    });
    return child as unknown as ChildProcess;
  };
  return { impl, calls };
}

function silentLogger() {
  return createProgressLogger({
    component: "playwright",
    sink: () => {},
    now: () => 0,
  });
}

/** Build a throwaway @playwright/mcp/package.json to back version detection. */
function stubMcpInstall(version: string): string {
  const root = mkdtempSync(join(tmpdir(), "pw-heal-"));
  const mcpDir = join(root, "node_modules", "@playwright", "mcp");
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(
    join(mcpDir, "package.json"),
    JSON.stringify({ name: "@playwright/mcp", version }),
  );
  const cli = join(mcpDir, "cli.js");
  writeFileSync(cli, "// stub");
  return cli;
}

describe("detectInstalledMcpVersion", () => {
  it("reads version from @playwright/mcp/package.json next to the CLI", () => {
    const cli = stubMcpInstall("0.0.70");
    expect(detectInstalledMcpVersion(cli)).toBe("0.0.70");
  });

  it("returns null when the package.json is missing or malformed", () => {
    expect(detectInstalledMcpVersion("/does/not/exist/cli.js")).toBeNull();
  });
});

describe("playwright heal — CLI presence / version", () => {
  it("constant is a valid pinned semver", () => {
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports the canonical browser list so validateConfig stays in sync", () => {
    expect([...SUPPORTED_BROWSERS]).toEqual([
      "chromium",
      "chrome",
      "firefox",
      "webkit",
      "msedge",
    ]);
  });

  it("fails when the CLI is missing", async () => {
    const { impl } = scriptedSpawn([]);
    const result = await createPlaywrightHeal({
      mcpBin: "/no/such/cli.js",
      installBrowsers: false as never, // legacy field, tolerated
    } as never)({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => false,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("executable-not-found");
  });

  it("fails on version drift (we refuse to mutate node_modules)", async () => {
    const cli = stubMcpInstall("0.0.69");
    const { impl } = scriptedSpawn([]);
    const result = await createPlaywrightHeal({
      mcpBin: cli,
      expectedVersion: "0.0.70",
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("version-mismatch");
    expect(result.error?.message).toContain("0.0.69");
    expect(result.error?.hint).toContain("npm install");
  });
});

describe("playwright heal — browser lifecycle", () => {
  it("skips browser check in remote-endpoint mode (no browser option)", async () => {
    const cli = stubMcpInstall("0.0.70");
    const { impl, calls } = scriptedSpawn([]);
    const result = await createPlaywrightHeal({
      mcpBin: cli,
      expectedVersion: "0.0.70",
      // no browser → remote mode
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("healthy");
    expect(calls).toHaveLength(0);
  });

  it("present browser → no install", async () => {
    const cli = stubMcpInstall("0.0.70");
    const { impl, calls } = scriptedSpawn([
      {
        match: (cmd, args) =>
          cmd === "npx" && args[0] === "playwright" && args[1] === "install",
        response: {
          stdout: "browser: chromium\nInstall location: /home/u/.cache\n",
        },
      },
    ]);
    const result = await createPlaywrightHeal({
      mcpBin: cli,
      browser: "chromium",
      expectedVersion: "0.0.70",
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("healthy");
    // Only the dry-run probe ran; no actual install.
    expect(calls.filter((c) => c.args.includes("install"))).toHaveLength(1);
    expect(calls[0].args).toContain("--dry-run");
  });

  it("missing browser → install runs, heal reports healthy", async () => {
    const cli = stubMcpInstall("0.0.70");
    const { impl, calls } = scriptedSpawn([
      // first dry-run: missing
      {
        match: (cmd, args) => cmd === "npx" && args.includes("--dry-run"),
        response: { stdout: "downloading chromium 120 MB\n" },
      },
      // actual install
      {
        match: (cmd, args) =>
          cmd === "npx" &&
          args[0] === "playwright" &&
          args[1] === "install" &&
          !args.includes("--dry-run"),
        response: { stdout: "installed chromium\n" },
      },
      // confirm dry-run after: installed
      {
        match: (cmd, args) => cmd === "npx" && args.includes("--dry-run"),
        response: {
          stdout: "browser: chromium\nInstall location: /home/u/.cache\n",
        },
      },
    ]);
    const result = await createPlaywrightHeal({
      mcpBin: cli,
      browser: "chromium",
      expectedVersion: "0.0.70",
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("healthy");
    expect(calls.some((c) => !c.args.includes("--dry-run"))).toBe(true);
  });

  it("install succeeds but dry-run still reports missing → degraded", async () => {
    const cli = stubMcpInstall("0.0.70");
    const { impl } = scriptedSpawn([
      {
        match: (cmd, args) => cmd === "npx" && args.includes("--dry-run"),
        response: { stdout: "downloading chromium 120 MB\n" },
      },
      {
        match: (cmd, args) =>
          cmd === "npx" &&
          args[0] === "playwright" &&
          args[1] === "install" &&
          !args.includes("--dry-run"),
        response: { stdout: "installed chromium\n" },
      },
      {
        match: (cmd, args) => cmd === "npx" && args.includes("--dry-run"),
        response: { stdout: "downloading chromium 120 MB\n" }, // still missing
      },
    ]);
    const result = await createPlaywrightHeal({
      mcpBin: cli,
      browser: "chromium",
      expectedVersion: "0.0.70",
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("degraded");
  });

  it("install subprocess fails with a network error → classified network", async () => {
    const cli = stubMcpInstall("0.0.70");
    const { impl } = scriptedSpawn([
      {
        match: (cmd, args) => cmd === "npx" && args.includes("--dry-run"),
        response: { stdout: "downloading chromium\n" },
      },
      {
        match: (cmd, args) =>
          cmd === "npx" &&
          args[0] === "playwright" &&
          args[1] === "install" &&
          !args.includes("--dry-run"),
        response: {
          exitCode: 1,
          stderr: "Error: Could not resolve host: playwright.azureedge.net\n",
        },
      },
    ]);
    const result = await createPlaywrightHeal({
      mcpBin: cli,
      browser: "chromium",
      expectedVersion: "0.0.70",
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("network");
  });
});
