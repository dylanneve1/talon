/**
 * Skill store — enable/disable marker + folder install
 * (`talon skill enable/disable/install`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
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
        if (prop === "skills") return join(workspaceDir, "skills");
        return target[prop as keyof typeof target];
      },
    }),
  };
});

import {
  installSkillFromDir,
  listSkills,
  readSkill,
  renderSkillsPrompt,
  saveSkill,
  searchSkills,
  setSkillEnabled,
} from "../storage/skill-store.js";

function writeSkillFolder(
  dir: string,
  frontmatter: string,
  body = "## Steps\n\n1. Do the thing.",
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

let sourceRoot: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-skill-ws-"));
  sourceRoot = mkdtempSync(join(tmpdir(), "talon-skill-src-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

describe("setSkillEnabled", () => {
  it("toggles the enabled flag via the .disabled marker", () => {
    saveSkill({ name: "demo", description: "a demo", body: "steps" });
    expect(readSkill("demo")!.enabled).toBe(true);

    expect(setSkillEnabled("demo", false)).toBe(true);
    expect(readSkill("demo")!.enabled).toBe(false);
    expect(existsSync(join(workspaceDir, "skills", "demo", ".disabled"))).toBe(
      true,
    );

    expect(setSkillEnabled("demo", true)).toBe(true);
    expect(readSkill("demo")!.enabled).toBe(true);
  });

  it("is idempotent in both directions", () => {
    saveSkill({ name: "demo", description: "a demo", body: "steps" });
    expect(setSkillEnabled("demo", false)).toBe(true);
    expect(setSkillEnabled("demo", false)).toBe(true);
    expect(setSkillEnabled("demo", true)).toBe(true);
    expect(setSkillEnabled("demo", true)).toBe(true);
    expect(readSkill("demo")!.enabled).toBe(true);
  });

  it("returns false for missing skills and invalid names", () => {
    expect(setSkillEnabled("missing", false)).toBe(false);
    expect(setSkillEnabled("../escape", false)).toBe(false);
  });

  it("does not list the marker as a bundled resource", () => {
    saveSkill({ name: "demo", description: "a demo", body: "steps" });
    setSkillEnabled("demo", false);
    expect(readSkill("demo")!.resources).toEqual([]);
  });

  it("survives a save_skill update (marker lives beside SKILL.md)", () => {
    saveSkill({ name: "demo", description: "a demo", body: "steps" });
    setSkillEnabled("demo", false);
    saveSkill({ name: "demo", description: "updated", body: "new steps" });
    expect(readSkill("demo")!.enabled).toBe(false);
  });
});

describe("disabled skills in prompt and search", () => {
  it("drops disabled skills from the prompt index but not list_skills", () => {
    saveSkill({ name: "keep", description: "kept skill", body: "steps" });
    saveSkill({ name: "hide", description: "hidden skill", body: "steps" });
    setSkillEnabled("hide", false);

    const prompt = renderSkillsPrompt();
    expect(prompt).toContain("keep");
    expect(prompt).not.toContain("hide");

    const names = listSkills().map((skill) => skill.name);
    expect(names).toEqual(["hide", "keep"]);
  });

  it("returns an empty prompt when every skill is disabled", () => {
    saveSkill({ name: "only", description: "the only one", body: "steps" });
    setSkillEnabled("only", false);
    expect(renderSkillsPrompt()).toBe("");
  });

  it("excludes disabled skills from search", () => {
    saveSkill({ name: "review-pr", description: "review PRs", body: "steps" });
    setSkillEnabled("review-pr", false);
    expect(searchSkills("review")).toEqual([]);
  });
});

describe("installSkillFromDir", () => {
  it("installs a folder under its frontmatter name, resources included", () => {
    const src = join(sourceRoot, "checkout-dir-name");
    writeSkillFolder(src, "name: pdf-tools\ndescription: work with PDFs");
    writeFileSync(join(src, "helper.py"), "print('hi')\n");

    const outcome = installSkillFromDir(src);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.skill.name).toBe("pdf-tools");
    expect(outcome.skill.enabled).toBe(true);
    expect(outcome.skill.resources).toEqual(["helper.py"]);
    // Frontmatter name wins over the checkout's folder name.
    expect(readSkill("checkout-dir-name")).toBeUndefined();
  });

  it("rejects a folder without SKILL.md", () => {
    const src = join(sourceRoot, "empty");
    mkdirSync(src, { recursive: true });
    const outcome = installSkillFromDir(src);
    expect(outcome).toMatchObject({ ok: false });
  });

  it("rejects invalid frontmatter", () => {
    const src = join(sourceRoot, "bad");
    writeSkillFolder(src, "name: 'has spaces in it!'\ndescription: x");
    const outcome = installSkillFromDir(src);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("Invalid skill");
  });

  it("refuses to overwrite without force, replaces with force", () => {
    saveSkill({ name: "demo", description: "original", body: "v1" });
    setSkillEnabled("demo", false);

    const src = join(sourceRoot, "demo-v2");
    writeSkillFolder(src, "name: demo\ndescription: replacement");

    const refused = installSkillFromDir(src);
    expect(refused.ok).toBe(false);

    const replaced = installSkillFromDir(src, { force: true });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.skill.description).toBe("replacement");
    // A force reinstall is a fresh skill — the old disabled state goes too.
    expect(replaced.skill.enabled).toBe(true);
  });
});
