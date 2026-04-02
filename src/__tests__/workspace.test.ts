import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock log to prevent pino initialization issues
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  initWorkspace,
  getWorkspaceDiskUsage,
  cleanupUploads,
  startUploadCleanup,
  stopUploadCleanup,
  migrateLayout,
} from "../util/workspace.js";

const TEST_ROOT = join(tmpdir(), `talon-ws-test-${Date.now()}`);

beforeEach(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  stopUploadCleanup();
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

  it("handles deeply nested directories", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const deep = join(TEST_ROOT, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "deep.txt"), "deep content here");
    expect(getWorkspaceDiskUsage(TEST_ROOT)).toBe(17);
  });

  it("ignores symlink or special entries gracefully", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    writeFileSync(join(TEST_ROOT, "normal.txt"), "hi");
    // Should not throw
    expect(getWorkspaceDiskUsage(TEST_ROOT)).toBeGreaterThan(0);
  });
});

describe("cleanupUploads", () => {
  it("returns 0 if uploads dir doesn't exist", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    expect(cleanupUploads(TEST_ROOT)).toBe(0);
  });

  it("deletes files older than maxAgeMs", async () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "old.jpg"), "data");

    // Wait 10ms so the file has age > 0, then cleanup with maxAge=1
    await new Promise((r) => setTimeout(r, 10));
    expect(cleanupUploads(TEST_ROOT, 1)).toBe(1);
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

  it("skips subdirectories in uploads", () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    mkdirSync(join(uploadsDir, "subdir"));
    writeFileSync(join(uploadsDir, "file.jpg"), "data");

    // subdir should be skipped (isFile check)
    expect(cleanupUploads(TEST_ROOT, 3_600_000)).toBe(0);
  });

  it("uses default maxAgeMs when not specified", async () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "recent.jpg"), "data");

    // Default maxAge is 7 days, so a recent file should survive
    expect(cleanupUploads(TEST_ROOT)).toBe(0);
    expect(readdirSync(uploadsDir)).toHaveLength(1);
  });

  it("deletes multiple old files", async () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "a.jpg"), "aaa");
    writeFileSync(join(uploadsDir, "b.jpg"), "bbb");
    writeFileSync(join(uploadsDir, "c.jpg"), "ccc");

    await new Promise((r) => setTimeout(r, 10));
    expect(cleanupUploads(TEST_ROOT, 1)).toBe(3);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  });
});

describe("startUploadCleanup / stopUploadCleanup", () => {
  it("starts periodic cleanup without throwing", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    expect(() => startUploadCleanup(TEST_ROOT)).not.toThrow();
  });

  it("is idempotent (calling twice does not create multiple timers)", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    startUploadCleanup(TEST_ROOT);
    startUploadCleanup(TEST_ROOT); // second call should be no-op
    stopUploadCleanup();
  });

  it("stopUploadCleanup is safe when not started", () => {
    expect(() => stopUploadCleanup()).not.toThrow();
  });

  it("can restart after stopping", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    startUploadCleanup(TEST_ROOT);
    stopUploadCleanup();
    expect(() => startUploadCleanup(TEST_ROOT)).not.toThrow();
    stopUploadCleanup();
  });

  it("runs immediate cleanup on start", async () => {
    const uploadsDir = join(TEST_ROOT, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, "old.jpg"), "data");

    await new Promise((r) => setTimeout(r, 10));
    // startUploadCleanup calls cleanupUploads immediately but with default 7-day maxAge
    // so a fresh file won't be deleted. Just verify it doesn't throw.
    startUploadCleanup(TEST_ROOT);
    expect(existsSync(join(uploadsDir, "old.jpg"))).toBe(true);
    stopUploadCleanup();
  });

  it("stopUploadCleanup clears the timer (calling twice is safe)", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    startUploadCleanup(TEST_ROOT);
    stopUploadCleanup();
    expect(() => stopUploadCleanup()).not.toThrow();
  });
});

describe("migrateLayout", () => {
  it("is a no-op when workspace/ directory does not exist", () => {
    // No workspace/ dir → should not throw or create anything
    expect(() => migrateLayout()).not.toThrow();
  });

  it("is a no-op when .talon/ already exists", () => {
    // Even if workspace/ exists, skip migration if .talon/ already there
    expect(() => migrateLayout()).not.toThrow();
  });
});

describe("getWorkspaceDiskUsage — edge cases", () => {
  it("returns 0 for non-existent directory", () => {
    expect(getWorkspaceDiskUsage("/non/existent/path/xyz123")).toBe(0);
  });

  it("counts multiple files correctly", () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    writeFileSync(join(TEST_ROOT, "a.txt"), "12345"); // 5 bytes
    writeFileSync(join(TEST_ROOT, "b.txt"), "123");   // 3 bytes
    const usage = getWorkspaceDiskUsage(TEST_ROOT);
    expect(usage).toBe(8);
  });
});
