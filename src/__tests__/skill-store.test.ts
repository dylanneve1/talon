/**
 * Skill store — markdown workflow bundle lifecycle.
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
  skillPath,
  listSkills,
  readSkill,
  renderSkillsPrompt,
  saveSkill,
  searchSkills,
  validateSkillBody,
  validateSkillDescription,
  validateSkillName,
} from "../storage/skill-store.js";

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-skills-"));
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("validation", () => {
  it("accepts slug names and rejects invalid metadata", () => {
    expect(validateSkillName("gh-review-v1")).toBeNull();
    expect(validateSkillName("bad name")).toMatch(/letters/);
    expect(validateSkillDescription("review workflow")).toBeNull();
    expect(validateSkillDescription("")).toMatch(/Missing/);
    expect(validateSkillBody("## Steps\n\nDo things")).toBeNull();
    expect(validateSkillBody("   ")).toMatch(/Missing/);
  });
});

describe("save / read / list / delete", () => {
  it("writes markdown with front matter and round-trips the body", () => {
    const skill = saveSkill({
      name: "review-pr",
      description: "review pull requests",
      body: "## Steps\n\n1. Read diff.\n2. Run tests.",
    });

    expect(skill.path).toBe(skillPath("review-pr"));
    expect(readFileSync(skill.path, "utf-8")).toContain(
      'description: "review pull requests"',
    );
    if (process.platform !== "win32") {
      expect(statSync(skill.path).mode & 0o777).toBe(0o600);
    }

    const loaded = readSkill("review-pr");
    expect(loaded?.name).toBe("review-pr");
    expect(loaded?.description).toBe("review pull requests");
    expect(loaded?.body).toContain("Run tests");
  });

  it("lists, formats, renders prompt discovery, and deletes", () => {
    saveSkill({
      name: "release-check",
      description: "ship a release",
      body: "## Release\n\nCheck CI first.",
    });

    const listed = listSkills();
    expect(listed.map((s) => s.name)).toEqual(["release-check", "review-pr"]);
    expect(formatSkill(listed[0])).toContain("release-check");

    const prompt = renderSkillsPrompt();
    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("find_skills");
    expect(prompt).toContain("read_skill");
    expect(prompt).toContain("review-pr");

    expect(deleteSkill("review-pr")).toBe(true);
    expect(existsSync(skillPath("review-pr"))).toBe(false);
    expect(deleteSkill("review-pr")).toBe(false);
  });

  it("searches skills by relevant workflow terms", () => {
    saveSkill({
      name: "github-review",
      description: "address GitHub pull request review comments",
      body: "Use the GraphQL unresolved review thread flow, inspect inline comments, patch code, run tests, then resolve threads.",
    });
    saveSkill({
      name: "release-check",
      description: "ship a release",
      body: "Check CI first.",
    });

    const results = searchSkills("unresolved review comments");
    expect(results.map((result) => result.skill.name)[0]).toBe("github-review");
    expect(results[0].snippet).toContain("unresolved review thread");
    expect(searchSkills("no-such-workflow")).toEqual([]);
  });

  it("rejects path-traversal names in read and delete", () => {
    expect(readSkill("../escape")).toBeUndefined();
    expect(deleteSkill("../escape")).toBe(false);
  });
});
