import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use a unique temp directory for each test run
const TEST_ROOT = join(tmpdir(), `talon-daily-log-test-${Date.now()}`);
const LOGS_DIR = join(TEST_ROOT, "workspace", "logs");

// We need to override process.cwd() so the daily-log module resolves its
// LOGS_DIR relative to our temp directory. Since the module uses
// resolve(process.cwd(), "workspace", "logs"), we mock process.cwd.
const originalCwd = process.cwd;

beforeEach(() => {
  process.cwd = () => TEST_ROOT;
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  process.cwd = originalCwd;
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe("daily-log", () => {
  describe("appendDailyLog", () => {
    it("creates the log file if missing", async () => {
      // Re-import to pick up the mocked cwd
      const { appendDailyLog, getLogsDir } = await import(
        "../storage/daily-log.js"
      );

      // Ensure logs dir doesn't exist yet
      expect(existsSync(LOGS_DIR)).toBe(false);

      appendDailyLog("TestChat", "User asked about weather");

      // The logs dir should now exist
      const logsDir = getLogsDir();
      expect(existsSync(logsDir)).toBe(true);

      // There should be a log file for today
      const files = readdirSync(logsDir);
      expect(files.length).toBeGreaterThanOrEqual(1);

      const todayStr = new Date().toISOString().slice(0, 10);
      const todayFile = files.find((f) => f.startsWith(todayStr));
      expect(todayFile).toBeDefined();
    });

    it("appends to existing file", async () => {
      const { appendDailyLog, getLogsDir } = await import(
        "../storage/daily-log.js"
      );

      appendDailyLog("Chat1", "First entry");
      appendDailyLog("Chat2", "Second entry");

      const logsDir = getLogsDir();
      const todayStr = new Date().toISOString().slice(0, 10);
      const logFile = join(logsDir, `${todayStr}.md`);

      const content = readFileSync(logFile, "utf-8");
      expect(content).toContain("First entry");
      expect(content).toContain("Second entry");
      expect(content).toContain("[Chat1]");
      expect(content).toContain("[Chat2]");
    });

    it("uses correct log format (## HH:MM -- [name])", async () => {
      const { appendDailyLog, getLogsDir } = await import(
        "../storage/daily-log.js"
      );

      appendDailyLog("MyChat", "Did some testing");

      const logsDir = getLogsDir();
      const todayStr = new Date().toISOString().slice(0, 10);
      const logFile = join(logsDir, `${todayStr}.md`);

      const content = readFileSync(logFile, "utf-8");

      // Format: ## HH:MM -- [chatName]
      expect(content).toMatch(/## \d{2}:\d{2} -- \[MyChat\]/);
      // Summary line: - summary
      expect(content).toContain("- Did some testing");
    });

    it("uses workspace/logs/ directory", async () => {
      const { appendDailyLog, getLogsDir } = await import(
        "../storage/daily-log.js"
      );

      appendDailyLog("LogDirTest", "checking path");

      const logsDir = getLogsDir();
      expect(logsDir).toContain("workspace");
      expect(logsDir).toContain("logs");
    });
  });
});
