import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Silence the logger
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const {
  initTriggers,
  spawnTrigger,
  cancelTrigger,
  shutdownTriggers,
  getRunningCount,
} = await import("../core/triggers.js");

import type { Trigger } from "../storage/trigger-store.js";

const {
  addTrigger,
  generateTriggerId,
  getTrigger,
  _resetTriggersForTesting,
  DEFAULT_TIMEOUT_SECONDS,
} = await import("../storage/trigger-store.js");

import { writeFileSync, mkdirSync } from "node:fs";

let tmpRoot: string;
let executeSpy: ReturnType<typeof vi.fn>;

function makeTrigger(opts: {
  body: string;
  language?: "bash" | "python" | "node";
  timeoutSeconds?: number;
  ext?: string;
}): Trigger {
  const id = generateTriggerId();
  const language = opts.language ?? "bash";
  const ext =
    opts.ext ??
    (language === "bash" ? "sh" : language === "python" ? "py" : "js");
  const scriptPath = resolve(tmpRoot, `${id}.${ext}`);
  const logPath = resolve(tmpRoot, `${id}.log`);
  writeFileSync(scriptPath, opts.body, { mode: 0o700 });

  const t: Trigger = {
    id,
    chatId: "chat-1",
    numericChatId: 1,
    name: `t-${id.slice(-6)}`,
    language,
    scriptPath,
    logPath,
    status: "pending",
    createdAt: Date.now(),
    timeoutSeconds: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
  };
  addTrigger(t);
  return t;
}

function waitForStatus(
  id: string,
  predicate: (status: string) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      const t = getTrigger(id);
      if (t && predicate(t.status)) return res();
      if (Date.now() - start > timeoutMs)
        return rej(new Error(`timeout waiting on ${id} (status=${t?.status})`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForRunningCount(target: number, timeoutMs = 5000): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      if (getRunningCount() === target) return res();
      if (Date.now() - start > timeoutMs)
        return rej(
          new Error(
            `timeout waiting for running count ${target} (got ${getRunningCount()})`,
          ),
        );
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "talon-trigger-test-"));
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetTriggersForTesting();
  executeSpy = vi.fn(async () => ({
    text: "ok",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }));
  initTriggers({ execute: executeSpy as never });
});

describe("trigger supervisor", () => {
  it("fires a wake-up on clean exit 0 with stdout payload", async () => {
    const t = makeTrigger({
      body: 'echo "task done"\nexit 0\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");

    expect(getTrigger(t.id)!.exitCode).toBe(0);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    expect(call.source).toBe("trigger");
    expect(call.senderName).toBe("Trigger");
    expect(call.chatId).toBe("chat-1");
    expect(call.prompt).toMatch(/Status: fired/);
    expect(call.prompt).toMatch(/task done/);
  });

  it("fires an error wake-up on non-zero exit", async () => {
    const t = makeTrigger({
      body: 'echo "boom" >&2\nexit 7\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "errored");
    expect(getTrigger(t.id)!.exitCode).toBe(7);

    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: errored/);
    expect(call.prompt).toMatch(/boom/);
  });

  it("fires mid-run on TALON_FIRE: lines without exiting", async () => {
    // Two TALON_FIRE: lines, then exit 0. We expect 3 fires total: 2 mid-run + 1 terminal.
    const t = makeTrigger({
      body:
        'echo "TALON_FIRE: alpha"\n' +
        'echo "ignored regular line"\n' +
        'echo "TALON_FIRE: beta"\n' +
        "exit 0\n",
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");

    // The terminal fire is async, so wait a beat for the dispatcher call to land
    await new Promise((r) => setTimeout(r, 50));
    expect(executeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const prompts = executeSpy.mock.calls.map((c) => c[0].prompt as string);
    expect(prompts.some((p) => p.includes("alpha"))).toBe(true);
    expect(prompts.some((p) => p.includes("beta"))).toBe(true);
    expect(getTrigger(t.id)!.fireCount).toBeGreaterThanOrEqual(2);
  });

  it("cancelTrigger SIGTERMs a running script and marks cancelled", async () => {
    const t = makeTrigger({ body: "sleep 30\n" });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "running");
    expect(getRunningCount()).toBe(1);

    expect(cancelTrigger(t.id)).toBe(true);
    await waitForStatus(t.id, (s) => s === "cancelled");
    // Wait for the SIGTERM to actually take effect and finalizeExit to run
    await waitForRunningCount(0);
  });

  it("hard timeout kills the script and fires a timed_out wake-up", async () => {
    const t = makeTrigger({ body: "sleep 30\n", timeoutSeconds: 1 });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "timed_out", 8000);
    const final = getTrigger(t.id)!;
    expect(final.status).toBe("timed_out");
    expect(final.lastError).toMatch(/Timed out/);
  });

  it("rejects unsupported languages without spawning", () => {
    const t = makeTrigger({ body: "echo hi" });
    // Force an unsupported language post-creation to test the supervisor guard
    (t as { language: string }).language = "ruby";
    spawnTrigger(t);
    expect(getTrigger(t.id)!.status).toBe("errored");
    expect(getTrigger(t.id)!.lastError).toMatch(/Unsupported language/);
  });

  it("shutdownTriggers terminates all running children", async () => {
    const a = makeTrigger({ body: "sleep 30\n" });
    const b = makeTrigger({ body: "sleep 30\n" });
    spawnTrigger(a);
    spawnTrigger(b);
    await waitForStatus(a.id, (s) => s === "running");
    await waitForStatus(b.id, (s) => s === "running");

    await shutdownTriggers();
    await waitForStatus(a.id, (s) => s === "terminated");
    await waitForStatus(b.id, (s) => s === "terminated");
    expect(getRunningCount()).toBe(0);
  });

  it("writes interleaved stdout + stderr to the log file", async () => {
    const t = makeTrigger({
      body: 'echo "from stdout"\necho "from stderr" >&2\nexit 0\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");

    expect(existsSync(t.logPath)).toBe(true);
    const log = readFileSync(t.logPath, "utf-8");
    expect(log).toMatch(/from stdout/);
    expect(log).toMatch(/\[stderr\] from stderr/);
    expect(log).toMatch(/--- spawn/);
    expect(log).toMatch(/--- exit code=0/);
  });
});
