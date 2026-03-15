import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initWorkspace, getWorkspaceDiskUsage } from "../workspace.js";

describe("workspace", () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = join(
      tmpdir(),
      `workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  describe("initWorkspace", () => {
    it("creates all expected directories", () => {
      const dirs = initWorkspace(testRoot);

      expect(existsSync(dirs.root)).toBe(true);
      expect(existsSync(dirs.memory)).toBe(true);
      expect(existsSync(dirs.logs)).toBe(true);
      expect(existsSync(dirs.uploads)).toBe(true);
      expect(existsSync(dirs.files)).toBe(true);
      expect(existsSync(dirs.sessions)).toBe(true);
      expect(existsSync(dirs.scripts)).toBe(true);
      expect(existsSync(dirs.data)).toBe(true);
    });

    it("returns correct directory paths", () => {
      const dirs = initWorkspace(testRoot);

      expect(dirs.root).toBe(testRoot);
      expect(dirs.memory).toContain("memory");
      expect(dirs.logs).toContain("logs");
      expect(dirs.uploads).toContain("uploads");
      expect(dirs.files).toContain("files");
      expect(dirs.sessions).toContain("sessions");
      expect(dirs.scripts).toContain("scripts");
      expect(dirs.data).toContain("data");
    });

    it("is idempotent (safe to call multiple times)", () => {
      initWorkspace(testRoot);
      // Should not throw on second call
      const dirs = initWorkspace(testRoot);
      expect(existsSync(dirs.memory)).toBe(true);
    });

    it("migrates root-level session files to sessions/", () => {
      // Place a sessions.json at the workspace root
      writeFileSync(join(testRoot, "sessions.json"), '{"test": true}\n');
      const dirs = initWorkspace(testRoot);

      // Should be moved to sessions/
      expect(existsSync(join(dirs.sessions, "sessions.json"))).toBe(true);
      expect(existsSync(join(testRoot, "sessions.json"))).toBe(false);
    });

    it("migrates stale script files to scripts/", () => {
      writeFileSync(join(testRoot, "test.py"), "print('hello')");
      const dirs = initWorkspace(testRoot);

      expect(existsSync(join(dirs.scripts, "test.py"))).toBe(true);
      expect(existsSync(join(testRoot, "test.py"))).toBe(false);
    });

    it("migrates stale data files to data/", () => {
      writeFileSync(join(testRoot, "data.csv"), "a,b,c\n1,2,3");
      const dirs = initWorkspace(testRoot);

      expect(existsSync(join(dirs.data, "data.csv"))).toBe(true);
      expect(existsSync(join(testRoot, "data.csv"))).toBe(false);
    });

    it("migrates unknown files to files/", () => {
      writeFileSync(join(testRoot, "photo.png"), "fake-png-data");
      const dirs = initWorkspace(testRoot);

      expect(existsSync(join(dirs.files, "photo.png"))).toBe(true);
      expect(existsSync(join(testRoot, "photo.png"))).toBe(false);
    });
  });

  describe("getWorkspaceDiskUsage", () => {
    it("calculates total size of files in directory", () => {
      mkdirSync(join(testRoot, "sub"), { recursive: true });
      const data1 = "hello world"; // 11 bytes
      const data2 = "test data here"; // 14 bytes
      writeFileSync(join(testRoot, "file1.txt"), data1);
      writeFileSync(join(testRoot, "sub", "file2.txt"), data2);

      const usage = getWorkspaceDiskUsage(testRoot);
      expect(usage).toBe(25);
    });

    it("returns 0 for empty directory", () => {
      const usage = getWorkspaceDiskUsage(testRoot);
      expect(usage).toBe(0);
    });

    it("handles nested directories", () => {
      mkdirSync(join(testRoot, "a", "b", "c"), { recursive: true });
      writeFileSync(join(testRoot, "a", "b", "c", "deep.txt"), "deep");

      const usage = getWorkspaceDiskUsage(testRoot);
      expect(usage).toBe(4); // "deep" = 4 bytes
    });
  });
});
