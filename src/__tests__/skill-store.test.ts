/**
 * Skill store — validation, CRUD, and script-file lifecycle against
 * the real (per-worker throwaway) SQLite database and a per-suite
 * tmpdir workspace.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
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

import {
  deleteSkill,
  formatSkill,
  getAllSkills,
  getSkill,
  recordSkillUse,
  saveSkill,
  validateSkillDescription,
  validateSkillLanguage,
  validateSkillName,
  validateSkillScript,
} from "../storage/skill-store.js";

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-skills-"));
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("validation", () => {
  it("accepts slug names, rejects spaces/dots/empty", () => {
    expect(validateSkillName("fetch_report-v2")).toBeNull();
    expect(validateSkillName("")).toMatch(/Missing/);
    expect(validateSkillName("has space")).toMatch(/letters/);
    expect(validateSkillName("dot.name")).toMatch(/letters/);
    expect(validateSkillName("x".repeat(65))).toMatch(/letters/);
  });

  it("validates language, script, and description", () => {
    expect(validateSkillLanguage("bash")).toBe(true);
    expect(validateSkillLanguage("lua")).toBe(false);
    expect(validateSkillScript("echo hi")).toBeNull();
    expect(validateSkillScript("  ")).toMatch(/Missing/);
    expect(validateSkillScript("x".repeat(65 * 1024))).toMatch(/too large/);
    expect(validateSkillDescription("does a thing")).toBeNull();
    expect(validateSkillDescription("")).toMatch(/Missing/);
    expect(validateSkillDescription("x".repeat(301))).toMatch(/too long/);
  });
});

describe("save / get / delete lifecycle", () => {
  it("writes the script file (owner-only mode) and round-trips metadata", () => {
    const skill = saveSkill({
      name: "greet",
      description: "prints a greeting",
      language: "bash",
      script: "echo hello",
    });
    expect(skill.scriptPath).toContain(join("skills", "greet.sh"));
    expect(readFileSync(skill.scriptPath, "utf-8")).toBe("echo hello");
    // 0o700 — owner read/write/exec only. Windows has no POSIX modes
    // (chmod is a no-op; stat reports 0o666), so assert POSIX-only.
    if (process.platform !== "win32") {
      expect(statSync(skill.scriptPath).mode & 0o777).toBe(0o700);
    }

    const loaded = getSkill("greet");
    expect(loaded).toEqual(skill);
    expect(loaded?.useCount).toBe(0);
  });

  it("save to an existing name replaces; language change swaps the file", () => {
    const v1 = saveSkill({
      name: "transform",
      description: "v1",
      language: "bash",
      script: "echo v1",
    });
    const v2 = saveSkill({
      name: "transform",
      description: "v2",
      language: "node",
      script: "console.log('v2')",
    });
    expect(v2.id).toBe(v1.id); // identity stable across updates
    expect(v2.createdAt).toBe(v1.createdAt);
    expect(v2.description).toBe("v2");
    expect(v2.scriptPath.endsWith(".mjs")).toBe(true);
    expect(existsSync(v1.scriptPath)).toBe(false); // old .sh removed
    expect(getAllSkills().filter((s) => s.name === "transform")).toHaveLength(
      1,
    );
  });

  it("records use and deletes (including the script file)", () => {
    const skill = saveSkill({
      name: "counted",
      description: "use counting",
      language: "bash",
      script: "true",
    });
    recordSkillUse("counted");
    recordSkillUse("counted");
    const used = getSkill("counted");
    expect(used?.useCount).toBe(2);
    expect(used?.lastUsedAt).toBeGreaterThan(0);

    expect(deleteSkill("counted")).toBe(true);
    expect(getSkill("counted")).toBeUndefined();
    expect(existsSync(skill.scriptPath)).toBe(false);
    expect(deleteSkill("counted")).toBe(false);
  });
});

describe("formatSkill", () => {
  it("renders name, language, usage, and description on one line", () => {
    const skill = saveSkill({
      name: "fmt-test",
      description: "formats things",
      language: "python",
      script: "print('x')",
    });
    const line = formatSkill(skill);
    expect(line).toContain("fmt-test");
    expect(line).toContain("python");
    expect(line).toContain("never used");
    expect(line).toContain("formats things");
  });
});
