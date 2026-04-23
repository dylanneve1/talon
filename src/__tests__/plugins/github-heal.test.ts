import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  GITHUB_MCP_IMAGE,
  createGithubHeal,
} from "../../plugins/github/heal.js";
import { createProgressLogger } from "../../plugins/common/progress.js";

/**
 * Heal tests exercise the four decision branches of the github lifecycle:
 *   1. daemon unreachable           → failed
 *   2. daemon OK, image present     → always re-pull to refresh digest
 *   3. daemon OK, image missing     → pull, then verify
 *   4. pull fails + cached image    → degraded (cached copy still works)
 *
 * We don't run real docker; the scripted spawn stages the sequence.
 */

type ResponseSpec = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
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
      child.emit("close", response.exitCode ?? 0, response.signal ?? null);
    });
    return child as unknown as ChildProcess;
  };
  return { impl, calls };
}

function silentLogger() {
  return createProgressLogger({
    component: "github",
    sink: () => {},
    now: () => 0,
  });
}

const isCmd =
  (name: string, firstArg?: string) => (cmd: string, args: readonly string[]) =>
    cmd === name && (firstArg === undefined || args[0] === firstArg);

describe("github heal", () => {
  it("pinned image constant is a pinned tag (never :latest)", () => {
    expect(GITHUB_MCP_IMAGE).toMatch(
      /^ghcr\.io\/github\/github-mcp-server:v\d+\.\d+\.\d+/,
    );
    expect(GITHUB_MCP_IMAGE).not.toContain(":latest");
  });

  it("happy path: daemon OK, image present, refresh pull succeeds", async () => {
    const { impl, calls } = scriptedSpawn([
      { match: isCmd("docker", "info"), response: { stdout: "24.0.7\n" } },
      { match: isCmd("docker", "image"), response: { stdout: "sha256:abc\n" } },
      {
        match: isCmd("docker", "pull"),
        response: { stdout: "Image is up to date\n" },
      },
      { match: isCmd("docker", "image"), response: { stdout: "sha256:abc\n" } },
    ]);
    const result = await createGithubHeal()({
      logger: silentLogger(),
      spawnImpl: impl,
    });
    expect(result.status).toBe("healthy");
    expect(result.identifier).toBe(GITHUB_MCP_IMAGE);
    // Confirms the "refresh even if present" behavior — pull is always called.
    expect(calls.filter((c) => c.args[0] === "pull")).toHaveLength(1);
  });

  it("cold start: image missing, pull resolves it", async () => {
    const { impl } = scriptedSpawn([
      { match: isCmd("docker", "info"), response: { stdout: "24.0.7\n" } },
      {
        match: isCmd("docker", "image"),
        response: { exitCode: 1, stderr: "No such image\n" },
      },
      {
        match: isCmd("docker", "pull"),
        response: { stdout: "Downloaded newer image\n" },
      },
      { match: isCmd("docker", "image"), response: { stdout: "sha256:new\n" } },
    ]);
    const result = await createGithubHeal()({
      logger: silentLogger(),
      spawnImpl: impl,
    });
    expect(result.status).toBe("healthy");
  });

  it("daemon unreachable → failed with executable-not-found hint", async () => {
    const { impl } = scriptedSpawn([
      {
        match: isCmd("docker", "info"),
        response: {
          spawnError: Object.assign(new Error("spawn ENOENT"), {
            code: "ENOENT",
          }) as NodeJS.ErrnoException,
        },
      },
    ]);
    const result = await createGithubHeal()({
      logger: silentLogger(),
      spawnImpl: impl,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("executable-not-found");
  });

  it("pull fails but image is cached → degraded (we run on stale digest)", async () => {
    const { impl } = scriptedSpawn([
      { match: isCmd("docker", "info"), response: { stdout: "24.0.7\n" } },
      {
        match: isCmd("docker", "image"),
        response: { stdout: "sha256:stale\n" },
      },
      {
        match: isCmd("docker", "pull"),
        response: {
          exitCode: 1,
          stderr: "error: Could not resolve host: ghcr.io\n",
        },
      },
    ]);
    const result = await createGithubHeal()({
      logger: silentLogger(),
      spawnImpl: impl,
    });
    expect(result.status).toBe("degraded");
    expect(result.error?.kind).toBe("network");
  });

  it("pull fails with no cached image → failed", async () => {
    const { impl } = scriptedSpawn([
      { match: isCmd("docker", "info"), response: { stdout: "24.0.7\n" } },
      {
        match: isCmd("docker", "image"),
        response: { exitCode: 1, stderr: "No such image\n" },
      },
      {
        match: isCmd("docker", "pull"),
        response: {
          exitCode: 1,
          stderr: "manifest unknown: manifest unknown\n",
        },
      },
    ]);
    const result = await createGithubHeal()({
      logger: silentLogger(),
      spawnImpl: impl,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("upstream-unavailable");
  });

  it("honors the image override (testing against a candidate tag)", async () => {
    const override = "ghcr.io/github/github-mcp-server:v0.9.0-rc1";
    const { impl, calls } = scriptedSpawn([
      { match: isCmd("docker", "info"), response: { stdout: "24.0.7\n" } },
      { match: isCmd("docker", "image"), response: { stdout: "sha256:rc\n" } },
      { match: isCmd("docker", "pull"), response: { stdout: "ok\n" } },
      { match: isCmd("docker", "image"), response: { stdout: "sha256:rc\n" } },
    ]);
    const result = await createGithubHeal({ image: override })({
      logger: silentLogger(),
      spawnImpl: impl,
    });
    expect(result.status).toBe("healthy");
    expect(result.identifier).toBe(override);
    expect(calls.some((c) => c.args.includes(override))).toBe(true);
  });
});
