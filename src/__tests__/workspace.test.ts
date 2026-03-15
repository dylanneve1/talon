import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, getWorkspaceDiskUsage } from "../workspace.js";

const TEST_ROOT = join(tmpdir(), `talon-ws-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe("initWorkspace", () => {
  it("creates root directory if missing", () => {
    initWorkspace(TEST_ROOT);
    expect(existsSync(TEST_ROOT)).toBe(true);
  });

  it("is idempotent", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    expect(() => initWorkspace(TEST_ROOT)).not.toThrow();
  });
});

describe("getWorkspaceDiskUsage", () => {
  it("returns 0 for empty directory", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    expect(getWorkspaceDiskUsage(TEST_ROOT)).toBe(0);
  });

  it("sums file sizes recursively", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const sub = join(TEST_ROOT, "sub");
    mkdirSync(sub);
    writeFileSync(join(TEST_ROOT, "a.txt"), "hello");
    writeFileSync(join(sub, "b.txt"), "world!");
    expect(getWorkspaceDiskUsage(TEST_ROOT)).toBe(11);
  });

  it("returns 0 for non-existent directory", () => {
    expect(getWorkspaceDiskUsage(join(TEST_ROOT, "nope"))).toBe(0);
  });
});
