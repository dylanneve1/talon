/**
 * Skill gateway actions — save/list/run/delete through
 * handleSharedAction, with run_skill executing REAL subprocesses
 * (bash + node) against a tmpdir workspace. Validation and store
 * internals are covered by skill-store.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

let workspaceDir: string;
vi.mock("../util/paths.js", async () => {
  const real =
    await vi.importActual<typeof import("../util/paths.js")>(
      "../util/paths.js",
    );
  return {
    ...real,
    dirs: new Proxy(real.dirs, {
      get(target, prop: string) {
        if (prop === "workspace") return workspaceDir;
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import { handleSharedAction } from "../core/engine/gateway-actions.js";
import type { ActionResult } from "../core/types.js";

const CHAT = 424242;

async function act(body: Record<string, unknown>): Promise<ActionResult> {
  const result = await handleSharedAction(body, CHAT);
  expect(result).not.toBeNull();
  return result!;
}

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-skill-actions-"));
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("save_skill", () => {
  it("saves and reports update-vs-create", async () => {
    const first = await act({
      action: "save_skill",
      name: "echo-args",
      description: "echoes its args",
      language: "bash",
      script: 'echo "args: $@"',
    });
    expect(first.ok).toBe(true);
    expect(first.text).toContain('Saved skill "echo-args"');

    const second = await act({
      action: "save_skill",
      name: "echo-args",
      description: "echoes its args (v2)",
      language: "bash",
      script: 'echo "args: $@"',
    });
    expect(second.ok).toBe(true);
    expect(second.text).toContain('Updated skill "echo-args"');
  });

  it("rejects bad names, languages, and empty scripts", async () => {
    expect(
      (
        await act({
          action: "save_skill",
          name: "bad name",
          description: "x",
          language: "bash",
          script: "true",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await act({
          action: "save_skill",
          name: "lua-skill",
          description: "x",
          language: "lua",
          script: "print(1)",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await act({
          action: "save_skill",
          name: "empty",
          description: "x",
          language: "bash",
          script: "   ",
        })
      ).ok,
    ).toBe(false);
  });
});

describe("run_skill", () => {
  it("runs a bash skill with args and returns stdout", async () => {
    const result = await act({
      action: "run_skill",
      name: "echo-args",
      args: ["alpha", "beta"],
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("exit 0");
    expect(result.text).toContain("args: alpha beta");
  });

  it("runs a node skill with cwd set to the workspace", async () => {
    await act({
      action: "save_skill",
      name: "node-cwd",
      description: "prints cwd",
      language: "node",
      script: "console.log(process.cwd())",
    });
    const result = await act({ action: "run_skill", name: "node-cwd" });
    expect(result.ok).toBe(true);
    // realpath vs symlinked tmpdir (macOS /var → /private/var): match the leaf
    expect(result.text).toContain("talon-skill-actions-");
  });

  it("surfaces non-zero exits as errors with stderr", async () => {
    await act({
      action: "save_skill",
      name: "fails",
      description: "always fails",
      language: "bash",
      script: 'echo "boom" >&2; exit 3',
    });
    const result = await act({ action: "run_skill", name: "fails" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exit 3");
    expect(result.error).toContain("boom");
  });

  it("kills runaway scripts at the timeout", async () => {
    await act({
      action: "save_skill",
      name: "sleeper",
      description: "sleeps forever",
      language: "bash",
      script: "sleep 60",
    });
    const result = await act({
      action: "run_skill",
      name: "sleeper",
      timeout_seconds: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("TIMED OUT");
  }, 15_000);

  it("rejects unknown skills and bad timeouts", async () => {
    const missing = await act({ action: "run_skill", name: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("list_skills");

    const badTimeout = await act({
      action: "run_skill",
      name: "echo-args",
      timeout_seconds: 9999,
    });
    expect(badTimeout.ok).toBe(false);
    expect(badTimeout.error).toContain("max");
  });
});

describe("list_skills / delete_skill", () => {
  it("lists saved skills with descriptions", async () => {
    const result = await act({ action: "list_skills" });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("echo-args");
    expect(result.text).toContain("echoes its args (v2)");
  });

  it("deletes and refuses unknowns", async () => {
    expect((await act({ action: "delete_skill", name: "fails" })).ok).toBe(
      true,
    );
    expect((await act({ action: "delete_skill", name: "fails" })).ok).toBe(
      false,
    );
  });
});
