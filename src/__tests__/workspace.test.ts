import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock log to prevent pino initialization issues
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import { initWorkspace, getWorkspaceDiskUsage, cleanupUploads } from "../util/workspace.js";

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

describe("cleanupUploads", () => {
  it("returns 0 if uploads dir doesn't exist", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    expect(cleanupUploads(TEST_ROOT)).toBe(0);
  });

  it("deletes files older than maxAgeMs", () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "old.jpg"), "data");

    // maxAge=0 means everything is "old"
    expect(cleanupUploads(TEST_ROOT, 0)).toBe(1);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });

  it("keeps recent files", () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "new.jpg"), "fresh");

    // 1 hour window — just-created file survives
    expect(cleanupUploads(TEST_ROOT, 3_600_000)).toBe(0);
    expect(readdirSync(uploadsDir)).toHaveLength(1);
  });
});
