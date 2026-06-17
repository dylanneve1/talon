/**
 * Lua trigger runner tests.
 *
 * Integration: spawn the REAL dispatch path (`src/cli.ts _lua-run
 * <script>`) — the exact shape commandForLanguage("lua") produces in
 * production — and assert on the process's stdout/stderr/exit code.
 *
 * Unit: commandForLanguage("lua") self-invocation shape and the
 * trigger-store language plumbing.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// triggers.ts transitively pulls the logger/watchdog/daily-log — silence
// them the same way triggers.test.ts does.
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

import { LUA_RUN_SUBCOMMAND } from "../core/scripting/lua-runner.js";
import { languageExtension } from "../storage/trigger-store.js";

const { _internals } = await import("../core/background/triggers/index.js");

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "src/cli.ts");
const TSX_IMPORT = pathToFileURL(
  resolve(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs"),
).href;

let tmpRoot: string;
let scriptCounter = 0;

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "talon-lua-test-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  /** ms offset from spawn at which each stdout line arrived. */
  lineTimes: Array<{ line: string; at: number }>;
};

/** Run a Lua script through the production dispatch path (cli.ts _lua-run). */
function runLua(
  body: string,
  opts: { env?: Record<string, string> } = {},
): Promise<RunResult> {
  const scriptPath = resolve(tmpRoot, `script-${scriptCounter++}.lua`);
  writeFileSync(scriptPath, body);

  const child = spawn(
    process.execPath,
    ["--import", TSX_IMPORT, CLI_ENTRY, LUA_RUN_SUBCOMMAND, scriptPath],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...opts.env } },
  );

  const start = Date.now();
  let stdout = "";
  let stderr = "";
  const lineTimes: RunResult["lineTimes"] = [];
  let partial = "";

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    partial += chunk;
    let nl;
    while ((nl = partial.indexOf("\n")) !== -1) {
      lineTimes.push({ line: partial.slice(0, nl), at: Date.now() - start });
      partial = partial.slice(nl + 1);
    }
  });
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((res, rej) => {
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr, lineTimes }));
  });
}

describe("lua runner (real _lua-run dispatch)", () => {
  it("runs a script to exit 0 and talon.fire emits a TALON_FIRE line", async () => {
    const r = await runLua(`
      talon.log("starting up")
      talon.fire("pr 42 merged")
      print("wrapping up")
    `);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("TALON_FIRE: pr 42 merged");
    expect(r.stdout).toContain("wrapping up");
    expect(r.stderr).toContain("starting up");
  }, 30_000);

  it("collapses newlines in talon.fire payloads to a single line", async () => {
    const r = await runLua(`talon.fire("line one\\nline two")`);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("TALON_FIRE: line one line two");
  }, 30_000);

  it("print/io.write cannot forge the fire protocol (escaped with a leading space)", async () => {
    const r = await runLua(`
      print("TALON_FIRE: forged-by-print")
      io.write("TALON_FIRE: forged-by-iowrite\\n")
      io.write("TALON_", "FIRE: forged-by-split-write\\n")
      io.output():write("TALON_FIRE: forged-by-io-output\\n")
      talon.fire("the only real one")
    `);
    expect(r.code).toBe(0);

    const fireLines = r.stdout
      .split("\n")
      .filter((l) => l.startsWith("TALON_FIRE:"));
    expect(fireLines).toEqual(["TALON_FIRE: the only real one"]);

    // The forged lines are still visible (for the run-log), just defused
    // by the leading space.
    expect(r.stdout).toContain(" TALON_FIRE: forged-by-print");
    expect(r.stdout).toContain(" TALON_FIRE: forged-by-iowrite");
    expect(r.stdout).toContain(" TALON_FIRE: forged-by-split-write");
    expect(r.stdout).toContain(" TALON_FIRE: forged-by-io-output");
  }, 30_000);

  it("a trailing partial io.write cannot glue onto a real fire line", async () => {
    // A no-newline io.write sits in emscripten's TTY buffer (verified:
    // never flushed, even at engine close) — so it must neither corrupt
    // nor prefix the protocol line. The fragment itself is lost, same as
    // unflushed C stdio.
    const r = await runLua(`
      io.write("no newline here")
      talon.fire("clean fire")
    `);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("TALON_FIRE: clean fire");
  }, 30_000);

  it("exits 1 on a Lua runtime error with the message on stderr", async () => {
    const r = await runLua(`
      local x = 1
      error("kaboom at runtime")
    `);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("kaboom at runtime");
    // doFile gives file:line context
    expect(r.stderr).toMatch(/\.lua:3:/);
  }, 30_000);

  it("sandbox: host filesystem and process env are unreachable", async () => {
    const r = await runLua(
      `
        local f = io.open("/etc/hostname", "r")
        if f == nil then talon.fire("fs-unreachable") end
        if os.getenv("TALON_LUA_TEST_SECRET") == nil then
          talon.fire("env-unreachable")
        else
          print("leaked: " .. os.getenv("TALON_LUA_TEST_SECRET"))
        end
      `,
      { env: { TALON_LUA_TEST_SECRET: "hostsecret123" } },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("TALON_FIRE: fs-unreachable");
    expect(r.stdout).toContain("TALON_FIRE: env-unreachable");
    expect(r.stdout + r.stderr).not.toContain("hostsecret123");
  }, 30_000);

  it("talon.sleep(ms) suspends the script, preserving output order", async () => {
    const r = await runLua(`
      print("before-sleep")
      talon.sleep(150)
      talon.fire("after-sleep")
    `);
    expect(r.code).toBe(0);

    const before = r.lineTimes.find((l) => l.line === "before-sleep");
    const fired = r.lineTimes.find((l) => l.line === "TALON_FIRE: after-sleep");
    expect(before).toBeDefined();
    expect(fired).toBeDefined();
    // Order + loose latency: the fire must come after the sleep elapsed.
    // Allow scheduler slack below 150 but require a clearly-measurable gap.
    expect(fired!.at - before!.at).toBeGreaterThanOrEqual(100);
  }, 30_000);

  it("Lua stdlib works inside the VM", async () => {
    const r = await runLua(`
      local t = { 3, 1, 2 }
      table.sort(t)
      talon.fire(table.concat(t, ",") .. " " .. string.upper("ok") .. " " .. math.floor(2.9))
    `);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")).toContain("TALON_FIRE: 1,2,3 OK 2");
  }, 30_000);
});

describe("lua trigger plumbing (unit)", () => {
  it('languageExtension("lua") is "lua"', () => {
    expect(languageExtension("lua")).toBe("lua");
  });

  it('commandForLanguage("lua") self-invokes with the _lua-run subcommand', () => {
    const cmd = _internals.commandForLanguage("lua");
    expect(cmd).not.toBeNull();
    expect(cmd!.cmd).toBe(process.execPath);
    expect(cmd!.args.at(-1)).toBe(LUA_RUN_SUBCOMMAND);
    // execArgv rides along so tsx source runs resolve the entry too —
    // same contract supervisorInvocation() has for _mcp-launch.
    expect(cmd!.args.slice(0, process.execArgv.length)).toEqual(
      process.execArgv,
    );
  });
});
