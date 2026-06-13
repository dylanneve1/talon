/**
 * Script store — validation, CRUD, and script-file lifecycle against
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
  deleteScript,
  formatScript,
  getAllScripts,
  getScript,
  recordScriptUse,
  saveScript,
  validateScriptDescription,
  validateScriptLanguage,
  validateScriptName,
  validateScriptBody,
} from "../storage/script-store.js";

beforeAll(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "talon-scripts-"));
});

afterAll(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("validation", () => {
  it("accepts slug names, rejects spaces/dots/empty", () => {
    expect(validateScriptName("fetch_report-v2")).toBeNull();
    expect(validateScriptName("")).toMatch(/Missing/);
    expect(validateScriptName("has space")).toMatch(/letters/);
    expect(validateScriptName("dot.name")).toMatch(/letters/);
    expect(validateScriptName("x".repeat(65))).toMatch(/letters/);
  });

  it("validates language, script, and description", () => {
    expect(validateScriptLanguage("bash")).toBe(true);
    expect(validateScriptLanguage("lua")).toBe(false);
    expect(validateScriptBody("echo hi")).toBeNull();
    expect(validateScriptBody("  ")).toMatch(/Missing/);
    expect(validateScriptBody("x".repeat(65 * 1024))).toMatch(/too large/);
    expect(validateScriptDescription("does a thing")).toBeNull();
    expect(validateScriptDescription("")).toMatch(/Missing/);
    expect(validateScriptDescription("x".repeat(301))).toMatch(/too long/);
  });
});

describe("save / get / delete lifecycle", () => {
  it("writes the script file (owner-only mode) and round-trips metadata", () => {
    const script = saveScript({
      name: "greet",
      description: "prints a greeting",
      language: "bash",
      script: "echo hello",
    });
    expect(script.scriptPath).toContain(join("scripts", "greet.sh"));
    expect(readFileSync(script.scriptPath, "utf-8")).toBe("echo hello");
    // 0o700 — owner read/write/exec only. Windows has no POSIX modes
    // (chmod is a no-op; stat reports 0o666), so assert POSIX-only.
    if (process.platform !== "win32") {
      expect(statSync(script.scriptPath).mode & 0o777).toBe(0o700);
    }

    const loaded = getScript("greet");
    expect(loaded).toEqual(script);
    expect(loaded?.useCount).toBe(0);
  });

  it("save to an existing name replaces; language change swaps the file", () => {
    const v1 = saveScript({
      name: "transform",
      description: "v1",
      language: "bash",
      script: "echo v1",
    });
    const v2 = saveScript({
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
    expect(getAllScripts().filter((s) => s.name === "transform")).toHaveLength(
      1,
    );
  });

  it("records use and deletes (including the script file)", () => {
    const script = saveScript({
      name: "counted",
      description: "use counting",
      language: "bash",
      script: "true",
    });
    recordScriptUse("counted");
    recordScriptUse("counted");
    const used = getScript("counted");
    expect(used?.useCount).toBe(2);
    expect(used?.lastUsedAt).toBeGreaterThan(0);

    expect(deleteScript("counted")).toBe(true);
    expect(getScript("counted")).toBeUndefined();
    expect(existsSync(script.scriptPath)).toBe(false);
    expect(deleteScript("counted")).toBe(false);
  });
});

describe("formatScript", () => {
  it("renders name, language, usage, and description on one line", () => {
    const script = saveScript({
      name: "fmt-test",
      description: "formats things",
      language: "python",
      script: "print('x')",
    });
    const line = formatScript(script);
    expect(line).toContain("fmt-test");
    expect(line).toContain("python");
    expect(line).toContain("never used");
    expect(line).toContain("formats things");
  });
});
