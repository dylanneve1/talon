/**
 * Functional smoke tests that launch real Talon processes without provider
 * credentials. The only test seam is TALON_TEST_BACKEND, which is available
 * only under NODE_ENV=test; config, workspace, gateway, frontend, dispatcher,
 * logging, PID handling, and signal shutdown all run for real.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INDEX_TS = resolve(REPO_ROOT, "src", "index.ts");
const TSX_IMPORT = resolve(
  REPO_ROOT,
  "node_modules",
  "tsx",
  "dist",
  "esm",
  "index.mjs",
);
const FUNCTIONAL_TIMEOUT_MS = 20_000;

type SpawnedTalon = {
  child: ChildProcess;
  homeDir: string;
  talonRoot: string;
  stdout: () => string;
  stderr: () => string;
};

const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 5_000).catch(() => child.kill("SIGKILL"));
    }
  }
  children.clear();
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Failed to reserve a free port");
  return port;
}

function writeConfig(homeDir: string, config: Record<string, unknown>): void {
  const talonRoot = join(homeDir, ".talon");
  rmSync(talonRoot, { recursive: true, force: true });
  mkdirSync(talonRoot, { recursive: true });
  writeFileSync(
    join(talonRoot, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
}

function spawnTalon(opts: {
  config: Record<string, unknown>;
  port?: number;
  env?: Record<string, string>;
}): SpawnedTalon {
  const homeDir = mkdtempSync(join(tmpdir(), "talon-functional-"));
  const talonRoot = join(homeDir, ".talon");
  writeConfig(homeDir, opts.config);

  let stdout = "";
  let stderr = "";
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(TSX_IMPORT).href, INDEX_TS],
    {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        HOME: homeDir,
        USERPROFILE: homeDir,
        TALON_GATEWAY_PORT: opts.port ? String(opts.port) : "",
        ...opts.env,
      },
    },
  );
  children.add(child);
  child.stdout?.on("data", (data) => {
    stdout += data.toString();
  });
  child.stderr?.on("data", (data) => {
    stderr += data.toString();
  });

  return {
    child,
    homeDir,
    talonRoot,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError}` : ""}`,
  );
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for process exit")),
      timeoutMs,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForHealth(port: number): Promise<Record<string, unknown>> {
  let health: Record<string, unknown> | undefined;
  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) return false;
      health = (await response.json()) as Record<string, unknown>;
      return true;
    },
    10_000,
    "Talon health endpoint",
  );
  return health!;
}

describe("talon functional process", () => {
  it(
    "starts a real terminal Talon instance with a providerless backend, answers a message, and shuts down cleanly",
    async () => {
      const port = await reservePort();
      const talon = spawnTalon({
        port,
        config: {
          frontend: "terminal",
          backend: "claude",
          model: "default",
          pulse: false,
          heartbeat: false,
          plugins: [],
        },
        env: {
          TALON_TEST_BACKEND: "1",
          TALON_TEST_BACKEND_RESPONSE: "functional response from test backend",
        },
      });

      const initialHealth = await waitForHealth(port);
      expect(initialHealth.ok).toBe(true);
      expect(initialHealth.bridge).toMatchObject({ activeChats: 0 });
      expect(existsSync(join(talon.talonRoot, "talon.pid"))).toBe(true);
      expect(
        existsSync(join(talon.talonRoot, "workspace", "identity.md")),
      ).toBe(true);

      talon.child.stdin?.write("hello from functional test\n");
      await waitFor(
        () => talon.stdout().includes("functional response from test backend"),
        10_000,
        "providerless backend response on stdout",
      );

      const afterMessageHealth = await waitForHealth(port);
      expect(afterMessageHealth.queue).toBe(0);
      expect(Number(afterMessageHealth.memory)).toBeGreaterThan(0);

      const logFile = join(talon.talonRoot, "talon.log");
      await waitFor(
        () =>
          existsSync(logFile) &&
          readFileSync(logFile, "utf-8").includes("Backend: Test"),
        3_000,
        "providerless backend startup log",
      );

      talon.child.kill("SIGTERM");
      const exit = await waitForExit(talon.child, 10_000);
      if (process.platform === "win32" && exit.signal === "SIGTERM") {
        // Windows terminates child processes for SIGTERM instead of delivering
        // it to Node's JS signal handler, so graceful cleanup is not observable
        // from a spawned child here. The same test asserts graceful cleanup on
        // POSIX where SIGTERM is delivered.
        expect(exit.code).toBeNull();
      } else {
        expect(exit.code).toBe(0);
        expect(existsSync(join(talon.talonRoot, "talon.pid"))).toBe(false);
        expect(readFileSync(logFile, "utf-8")).toContain("State saved");
      }

      rmSync(talon.homeDir, { recursive: true, force: true });
    },
    FUNCTIONAL_TIMEOUT_MS,
  );

  it(
    "fails fast for invalid frontend config without writing a PID file",
    async () => {
      const talon = spawnTalon({
        config: {
          frontend: "telegram",
          backend: "claude",
          model: "default",
          pulse: false,
          plugins: [],
        },
      });

      const exit = await waitForExit(talon.child, 10_000);
      expect(exit.code).not.toBe(0);
      expect(existsSync(join(talon.talonRoot, "talon.pid"))).toBe(false);
      expect(talon.stderr() + talon.stdout()).toContain(
        "Telegram frontend requires",
      );

      rmSync(talon.homeDir, { recursive: true, force: true });
    },
    FUNCTIONAL_TIMEOUT_MS,
  );

  it(
    "routes providerless backend actions through the real terminal gateway context",
    async () => {
      const port = await reservePort();
      const hiddenFallback = "fallback response should not be rendered";
      const bridgeText = "bridge action response from providerless backend";
      const talon = spawnTalon({
        port,
        config: {
          frontend: "terminal",
          backend: "claude",
          model: "default",
          pulse: false,
          heartbeat: false,
          plugins: [],
        },
        env: {
          TALON_TEST_BACKEND: "1",
          TALON_TEST_BACKEND_RESPONSE: hiddenFallback,
          TALON_TEST_BACKEND_ACTION_JSON: JSON.stringify({
            action: "send_message",
            text: bridgeText,
          }),
        },
      });

      await waitForHealth(port);
      talon.child.stdin?.write("call the action bridge\n");

      await waitFor(
        () => talon.stdout().includes(bridgeText),
        10_000,
        "terminal bridge action response on stdout",
      );
      await waitFor(
        async () => (await waitForHealth(port)).queue === 0,
        5_000,
        "providerless action query to drain",
      );

      expect(talon.stdout()).not.toContain(hiddenFallback);

      talon.child.kill("SIGTERM");
      await waitForExit(talon.child, 10_000);
      rmSync(talon.homeDir, { recursive: true, force: true });
    },
    FUNCTIONAL_TIMEOUT_MS,
  );
});
