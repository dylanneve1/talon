/**
 * Tests for workspace migrateLayout, identity seeding, and prompt seeding.
 * Uses temp directories and mocks process.cwd() + os.homedir().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_ROOT = join(tmpdir(), `talon-migrate-test-${Date.now()}`);
const OLD_WORKSPACE = join(TEST_ROOT, "workspace");
const NEW_ROOT = join(TEST_ROOT, ".talon");

beforeEach(() => {
  vi.resetModules();
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });

  vi.doMock("node:os", async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return { ...actual, homedir: () => TEST_ROOT };
  });
  vi.doMock("../util/log.js", () => ({
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logDebug: vi.fn(),
  }));
});

afterEach(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe("migrateLayout", () => {
  it("is a no-op when workspace/ does not exist", async () => {
    const { migrateLayout } = await import("../util/workspace.js");
    expect(() => migrateLayout()).not.toThrow();
    // workspace/sessions.json should NOT have been created since migration never ran
    expect(existsSync(join(NEW_ROOT, "data", "sessions.json"))).toBe(false);
  });

  it("is a no-op when .talon/ already exists", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    mkdirSync(NEW_ROOT, { recursive: true });

    const { migrateLayout } = await import("../util/workspace.js");
    expect(() => migrateLayout()).not.toThrow();
    // workspace/ should still exist — migration was skipped
    expect(existsSync(OLD_WORKSPACE)).toBe(true);
  });

  it("migrates files from workspace/ to .talon/ layout", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    writeFileSync(join(OLD_WORKSPACE, "sessions.json"), '{"chat1":{}}');
    writeFileSync(join(OLD_WORKSPACE, "history.json"), '{}');
    writeFileSync(join(OLD_WORKSPACE, "talon.json"), '{"frontend":"telegram"}');

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../util/workspace.js");
      migrateLayout();

      const dataDir = join(NEW_ROOT, "data");
      expect(existsSync(join(dataDir, "sessions.json"))).toBe(true);
      expect(existsSync(join(dataDir, "history.json"))).toBe(true);
      expect(existsSync(join(NEW_ROOT, "config.json"))).toBe(true);
      // Original files should be gone
      expect(existsSync(join(OLD_WORKSPACE, "sessions.json"))).toBe(false);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("migrates directories from workspace/ to .talon/workspace/ layout", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    const memoryDir = join(OLD_WORKSPACE, "memory");
    mkdirSync(memoryDir);
    writeFileSync(join(memoryDir, "notes.md"), "# Memory");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../util/workspace.js");
      migrateLayout();

      const newMemory = join(NEW_ROOT, "workspace", "memory");
      expect(existsSync(newMemory)).toBe(true);
      expect(existsSync(join(newMemory, "notes.md"))).toBe(true);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("removes empty workspace/ after migration", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    // No files — workspace/ is empty

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../util/workspace.js");
      migrateLayout();

      // Empty workspace/ should be removed
      expect(existsSync(OLD_WORKSPACE)).toBe(false);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("leaves workspace/ when non-migration files remain after migration", async () => {
    mkdirSync(OLD_WORKSPACE, { recursive: true });
    // A file that is NOT in the migration list
    writeFileSync(join(OLD_WORKSPACE, "unknown-extra-file.txt"), "extra");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { migrateLayout } = await import("../util/workspace.js");
      migrateLayout();

      // workspace/ should still exist since it's not empty
      expect(existsSync(OLD_WORKSPACE)).toBe(true);
      expect(existsSync(join(OLD_WORKSPACE, "unknown-extra-file.txt"))).toBe(true);
    } finally {
      process.cwd = originalCwd;
    }
  });
});

describe("initWorkspace — identity and prompt seeding", () => {
  it("creates identity.md when it does not exist", async () => {
    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { initWorkspace } = await import("../util/workspace.js");
      initWorkspace(join(TEST_ROOT, "ws"));

      // identity.md is at ~/.talon/workspace/identity.md
      const identityFile = join(NEW_ROOT, "workspace", "identity.md");
      expect(existsSync(identityFile)).toBe(true);
      const content = readFileSync(identityFile, "utf-8");
      expect(content).toContain("Identity");
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("seeds .md prompt files from prompts/ directory", async () => {
    // prompts/ is resolved relative to process.cwd()
    const promptsDir = join(TEST_ROOT, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "system.md"), "# System Prompt");
    writeFileSync(join(promptsDir, "dream.md"), "# Dream Prompt");
    writeFileSync(join(promptsDir, "not-a-prompt.txt"), "ignored");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { initWorkspace } = await import("../util/workspace.js");
      initWorkspace(join(TEST_ROOT, "ws"));

      // prompts are seeded to ~/.talon/prompts/
      const talonPromptsDir = join(NEW_ROOT, "prompts");
      expect(existsSync(join(talonPromptsDir, "system.md"))).toBe(true);
      expect(existsSync(join(talonPromptsDir, "dream.md"))).toBe(true);
      // .txt file should NOT be copied
      expect(existsSync(join(talonPromptsDir, "not-a-prompt.txt"))).toBe(false);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it("does not overwrite existing prompt files", async () => {
    const promptsDir = join(TEST_ROOT, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(join(promptsDir, "custom.md"), "# Package version");

    const talonPromptsDir = join(NEW_ROOT, "prompts");
    mkdirSync(talonPromptsDir, { recursive: true });
    writeFileSync(join(talonPromptsDir, "custom.md"), "# User customized version");

    const originalCwd = process.cwd;
    process.cwd = () => TEST_ROOT;

    try {
      const { initWorkspace } = await import("../util/workspace.js");
      initWorkspace(join(TEST_ROOT, "ws"));

      // User version should be preserved
      const content = readFileSync(join(talonPromptsDir, "custom.md"), "utf-8");
      expect(content).toBe("# User customized version");
    } finally {
      process.cwd = originalCwd;
    }
  });
});
