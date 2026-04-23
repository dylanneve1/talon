import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  MEMPALACE_FLOOR,
  MEMPALACE_TARGET,
  createMempalaceHeal,
} from "../../plugins/mempalace/heal.js";
import { createProgressLogger } from "../../plugins/common/progress.js";
import type { HealResult } from "../../plugins/common/lifecycle.js";

/**
 * Heal is the brain's bootstrap. Tests here target decision boundaries:
 * fresh install vs align vs skip, managed vs verify-only, happy vs failure
 * paths. The scripted fake spawn lets us stage multi-step subprocess
 * sequences deterministically without touching the network or pip.
 */

type FakeCall =
  | {
      match: (cmd: string, args: readonly string[]) => boolean;
      response: ResponseSpec;
    }
  | { match: true; response: ResponseSpec };

interface ResponseSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: NodeJS.ErrnoException;
}

function scriptedSpawn(script: FakeCall[]) {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const impl = (
    cmd: string,
    args: readonly string[],
    _opts: SpawnOptions,
  ): ChildProcess => {
    calls.push({ cmd, args });
    const idx = script.findIndex((c) => {
      if (c.match === true) return true;
      return c.match(cmd, args);
    });
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
    component: "mempalace",
    sink: () => {},
    now: () => 0,
  });
}

const PYTHON = "/home/u/.talon/mempalace-venv/bin/python";

describe("mempalace heal — managed mode (Talon owns the venv)", () => {
  it("happy path: venv exists, version at pin, mcp_server importable", async () => {
    const { impl } = scriptedSpawn([
      // detectVersion
      {
        match: (c, a) =>
          c === PYTHON && a[0] === "-c" && String(a[1]).includes("mempalace"),
        response: { stdout: MEMPALACE_TARGET },
      },
      // verify mcp_server importable
      {
        match: (c, a) =>
          c === PYTHON &&
          a[0] === "-c" &&
          String(a[1]).includes("mempalace.mcp_server"),
        response: { stdout: "" },
      },
    ]);
    const result = await createMempalaceHeal({
      pythonPath: PYTHON,
      managed: true,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("healthy");
    expect(result.identifier).toBe(`mempalace ${MEMPALACE_TARGET}`);
    expect(result.summary.some((s) => s.startsWith("venv:"))).toBe(true);
  });

  it("cold start: venv is created and mempalace is installed fresh", async () => {
    // Track existence as state, flipped after the venv subprocess completes.
    // The two existsSync probes the helper performs should see:
    //   1. before venv-create → false
    //   2. after venv-create  → true
    let pythonExists = false;
    const { impl, calls } = scriptedSpawn([
      {
        match: (_cmd, args) => args[0] === "-m" && args[1] === "venv",
        response: { stdout: "" },
      },
      // detectVersion → not installed
      {
        match: (c, a) => c === PYTHON && a[0] === "-c",
        response: { exitCode: 42 },
      },
      // pip install --upgrade mempalace==TARGET
      {
        match: (c, a) =>
          c === PYTHON && a[0] === "-m" && a[1] === "pip" && a[2] === "install",
        response: { stdout: "Successfully installed mempalace-3.3.2\n" },
      },
      // post-install detectVersion → target
      {
        match: (c, a) => c === PYTHON && a[0] === "-c",
        response: { stdout: MEMPALACE_TARGET },
      },
      // verify mcp_server
      {
        match: (c, a) => c === PYTHON && a[0] === "-c",
        response: { stdout: "" },
      },
    ]);

    // Wrap spawn impl to flip existsSync *after* the venv step settles.
    const wrappedImpl = (
      cmd: string,
      args: readonly string[],
      opts: Parameters<typeof impl>[2],
    ): ReturnType<typeof impl> => {
      const child = impl(cmd, args, opts);
      if (args[0] === "-m" && args[1] === "venv") {
        child.on("close", () => {
          pythonExists = true;
        });
      }
      return child;
    };

    const result = await createMempalaceHeal({
      pythonPath: PYTHON,
      managed: true,
    })({
      logger: silentLogger(),
      spawnImpl: wrappedImpl,
      existsSyncImpl: () => pythonExists,
    });

    expect(result.status).toBe("healthy");
    expect(calls.some((c) => c.args.includes("venv"))).toBe(true);
    expect(calls.some((c) => c.args.includes("install"))).toBe(true);
  });

  it("realigns when installed version differs from the pin (even if above floor)", async () => {
    const { impl, calls } = scriptedSpawn([
      // detectVersion → 3.4.0 (above floor, off-pin)
      {
        match: (c, a) =>
          c === PYTHON && a[0] === "-c" && String(a[1]).includes("mempalace"),
        response: { stdout: "3.4.0" },
      },
      // pip install --upgrade mempalace==TARGET (downgrade)
      {
        match: (_c, a) => a[0] === "-m" && a[1] === "pip" && a[2] === "install",
        response: { stdout: "Successfully installed mempalace-3.3.2\n" },
      },
      // re-detect → target
      {
        match: (c, a) =>
          c === PYTHON && a[0] === "-c" && String(a[1]).includes("mempalace"),
        response: { stdout: MEMPALACE_TARGET },
      },
      // mcp_server import
      {
        match: (c, a) =>
          c === PYTHON &&
          a[0] === "-c" &&
          String(a[1]).includes("mempalace.mcp_server"),
        response: { stdout: "" },
      },
    ]);
    const result = await createMempalaceHeal({
      pythonPath: PYTHON,
      managed: true,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("healthy");
    expect(calls.find((c) => c.args.includes("install"))).toBeDefined();
  });

  it("returns failed (classified network) when pip can't reach PyPI", async () => {
    const { impl } = scriptedSpawn([
      // detect → missing
      {
        match: (c, a) => c === PYTHON && a[0] === "-c",
        response: { exitCode: 42 },
      },
      // pip install → network error
      {
        match: (_c, a) => a[0] === "-m" && a[1] === "pip" && a[2] === "install",
        response: {
          exitCode: 1,
          stderr:
            "ERROR: Could not find a version that satisfies the requirement\nCould not resolve host: pypi.org\n",
        },
      },
    ]);
    const result: HealResult = await createMempalaceHeal({
      pythonPath: PYTHON,
      managed: true,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("network");
  });
});

describe("mempalace heal — verify-only mode (user-provided python)", () => {
  it("skipped install, allows above-floor off-pin version as healthy", async () => {
    const { impl, calls } = scriptedSpawn([
      // detect → 3.4.0 (above floor, off-pin)
      {
        match: (c, a) => c === "/usr/bin/python3" && a[0] === "-c",
        response: { stdout: "3.4.0" },
      },
      // mcp_server import
      {
        match: (c, a) => c === "/usr/bin/python3" && a[0] === "-c",
        response: { stdout: "" },
      },
    ]);
    const result = await createMempalaceHeal({
      pythonPath: "/usr/bin/python3",
      managed: false,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("healthy");
    // No pip call — we don't touch user's Python env.
    expect(calls.some((c) => c.args.includes("install"))).toBe(false);
  });

  it("returns degraded when user's version is below floor", async () => {
    const { impl } = scriptedSpawn([
      {
        match: (c, a) => c === "/usr/bin/python3" && a[0] === "-c",
        response: { stdout: "3.2.0" },
      },
    ]);
    const result = await createMempalaceHeal({
      pythonPath: "/usr/bin/python3",
      managed: false,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("degraded");
    expect(result.error?.kind).toBe("version-mismatch");
    expect(result.error?.message).toContain(MEMPALACE_FLOOR);
  });

  it("returns failed when user's python path does not exist", async () => {
    const { impl } = scriptedSpawn([]);
    const result = await createMempalaceHeal({
      pythonPath: "/does/not/exist",
      managed: false,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => false,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("executable-not-found");
  });

  it("returns failed when mempalace not installed at user-provided python", async () => {
    const { impl } = scriptedSpawn([
      // detect → import fails
      {
        match: (c, a) => c === "/usr/bin/python3" && a[0] === "-c",
        response: { exitCode: 42 },
      },
    ]);
    const result = await createMempalaceHeal({
      pythonPath: "/usr/bin/python3",
      managed: false,
    })({
      logger: silentLogger(),
      spawnImpl: impl,
      existsSyncImpl: () => true,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.kind).toBe("executable-not-found");
  });
});

describe("mempalace heal — misc", () => {
  it("exports MEMPALACE_TARGET matching MEMPALACE_FLOOR so the pin enforces the floor", () => {
    // Intentional: we only raise FLOOR when we bump TARGET. Having them
    // equal means "Talon-pinned === supported." When we bump, both move.
    expect(MEMPALACE_TARGET).toBe(MEMPALACE_FLOOR);
  });
});
