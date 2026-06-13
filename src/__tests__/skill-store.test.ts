/**
 * Skill store — SKILL.md workflow bundle lifecycle (folder layout).
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "yaml";

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
  it("writes <name>/SKILL.md with YAML frontmatter and round-trips the body", () => {
    const skill = saveSkill({
      name: "review-pr",
      description: "review pull requests",
      body: "## Steps\n\n1. Read diff.\n2. Run tests.",
    });

    expect(skill.path).toBe(skillPath("review-pr"));
    expect(basename(skill.path)).toBe("SKILL.md");

    const raw = readFileSync(skill.path, "utf-8");
    // Frontmatter parses as real YAML and round-trips name + description.
    const fmEnd = raw.indexOf("\n---", 4);
    const fm = parse(raw.slice(4, fmEnd)) as Record<string, unknown>;
    expect(fm.name).toBe("review-pr");
    expect(fm.description).toBe("review pull requests");

    if (process.platform !== "win32") {
      expect(statSync(skill.path).mode & 0o777).toBe(0o600);
    }

    const loaded = readSkill("review-pr");
    expect(loaded?.name).toBe("review-pr");
    expect(loaded?.description).toBe("review pull requests");
    expect(loaded?.body).toContain("Run tests");
  });

  it("enumerates bundled resources and preserves them across updates", () => {
    saveSkill({
      name: "bundled",
      description: "skill with extras",
      body: "## Steps\n\nUse helper.py.",
    });

    const dir = dirname(skillPath("bundled"));
    writeFileSync(join(dir, "helper.py"), "print('hi')\n");
    writeFileSync(join(dir, "template.md"), "# Template\n");

    const loaded = readSkill("bundled");
    expect(loaded?.resources).toContain("helper.py");
    expect(loaded?.resources).toContain("template.md");
    expect(loaded?.resources).not.toContain("SKILL.md");

    // Updating the skill must not delete sibling bundled files.
    saveSkill({
      name: "bundled",
      description: "skill with extras (v2)",
      body: "## Steps\n\nUpdated.",
    });
    expect(existsSync(join(dir, "helper.py"))).toBe(true);
    expect(existsSync(join(dir, "template.md"))).toBe(true);
    const reloaded = readSkill("bundled");
    expect(reloaded?.description).toBe("skill with extras (v2)");
    expect(reloaded?.resources).toContain("helper.py");

    deleteSkill("bundled");
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
