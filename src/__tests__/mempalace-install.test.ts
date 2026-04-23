import { describe, it, expect, vi } from "vitest";
import {
  MEMPALACE_INSTALL_TARGET,
  MEMPALACE_MIN_VERSION,
  compareSemVer,
  detectMempalaceVersion,
  ensureMempalaceInstalled,
  isVersionSupported,
  parseSemVer,
} from "../plugins/mempalace/install.js";

describe("parseSemVer", () => {
  it("parses basic X.Y.Z", () => {
    expect(parseSemVer("3.3.2")).toEqual({ major: 3, minor: 3, patch: 2 });
  });

  it("parses with trailing prerelease/whitespace", () => {
    expect(parseSemVer("  3.3.2-rc.1 ")).toEqual({
      major: 3,
      minor: 3,
      patch: 2,
    });
  });

  it("returns null for non-semver", () => {
    expect(parseSemVer("abc")).toBeNull();
    expect(parseSemVer("3.3")).toBeNull();
    expect(parseSemVer("")).toBeNull();
  });
});

describe("compareSemVer", () => {
  it("orders by major/minor/patch", () => {
    expect(
      compareSemVer(
        { major: 3, minor: 3, patch: 2 },
        { major: 3, minor: 3, patch: 1 },
      ),
    ).toBe(1);
    expect(
      compareSemVer(
        { major: 3, minor: 3, patch: 1 },
        { major: 3, minor: 3, patch: 2 },
      ),
    ).toBe(-1);
    expect(
      compareSemVer(
        { major: 3, minor: 3, patch: 2 },
        { major: 3, minor: 3, patch: 2 },
      ),
    ).toBe(0);
    expect(
      compareSemVer(
        { major: 4, minor: 0, patch: 0 },
        { major: 3, minor: 9, patch: 9 },
      ),
    ).toBe(1);
  });
});

describe("isVersionSupported", () => {
  it("returns true at and above the floor", () => {
    expect(isVersionSupported("3.3.2", "3.3.2")).toBe(true);
    expect(isVersionSupported("3.3.3", "3.3.2")).toBe(true);
    expect(isVersionSupported("3.4.0", "3.3.2")).toBe(true);
    expect(isVersionSupported("4.0.0", "3.3.2")).toBe(true);
  });

  it("returns false below the floor", () => {
    expect(isVersionSupported("3.3.1", "3.3.2")).toBe(false);
    expect(isVersionSupported("3.2.0", "3.3.2")).toBe(false);
  });

  it("returns false for unparseable versions", () => {
    expect(isVersionSupported("not-a-version", "3.3.2")).toBe(false);
  });
});

describe("constants", () => {
  it("MEMPALACE_MIN_VERSION is parseable semver", () => {
    expect(parseSemVer(MEMPALACE_MIN_VERSION)).not.toBeNull();
  });
  it("MEMPALACE_INSTALL_TARGET is parseable semver", () => {
    expect(parseSemVer(MEMPALACE_INSTALL_TARGET)).not.toBeNull();
  });
  it("install target is at or above the minimum", () => {
    const target = parseSemVer(MEMPALACE_INSTALL_TARGET)!;
    const floor = parseSemVer(MEMPALACE_MIN_VERSION)!;
    expect(compareSemVer(target, floor)).toBeGreaterThanOrEqual(0);
  });
});

describe("detectMempalaceVersion", () => {
  it("returns trimmed stdout when import succeeds", async () => {
    const fakeExec = vi.fn(async () => ({ stdout: "3.3.2\n", stderr: "" }));
    const result = await detectMempalaceVersion(
      "/fake/python",
      fakeExec as unknown as never,
    );
    expect(result).toBe("3.3.2");
    expect(fakeExec).toHaveBeenCalledOnce();
  });

  it("returns null when import throws", async () => {
    const fakeExec = vi.fn(async () => {
      throw new Error("ModuleNotFoundError: mempalace");
    });
    const result = await detectMempalaceVersion(
      "/fake/python",
      fakeExec as unknown as never,
    );
    expect(result).toBeNull();
  });

  it("returns null when stdout is empty", async () => {
    const fakeExec = vi.fn(async () => ({ stdout: "   ", stderr: "" }));
    const result = await detectMempalaceVersion(
      "/fake/python",
      fakeExec as unknown as never,
    );
    expect(result).toBeNull();
  });
});

describe("ensureMempalaceInstalled", () => {
  const venvPython = "/home/user/.talon/mempalace-venv/bin/python";

  function makeExec(
    responses: Array<{ stdout: string; stderr?: string } | Error>,
  ): ReturnType<typeof vi.fn> & { calls: unknown[] } {
    const calls: unknown[] = [];
    const impl = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("unexpected exec call (no response queued)");
      return next;
    };
    const fn = vi.fn(impl) as ReturnType<typeof vi.fn> & { calls: unknown[] };
    fn.calls = calls;
    return fn;
  }

  it("reports ok when python exists, venv, and version is supported", async () => {
    const exec = makeExec([{ stdout: "3.3.2\n" }]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: false,
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.version).toBe("3.3.2");
    expect(status.error).toBeUndefined();
  });

  it("errors without installing when autoInstall=false and python is missing", async () => {
    const exec = makeExec([]); // should never be called
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: false,
      existsSyncImpl: () => false,
      isVenvImpl: () => false,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("Python binary not found");
    expect(exec).not.toHaveBeenCalled();
  });

  it("creates venv + installs when autoInstall=true and python is missing", async () => {
    let pythonExistsAfterVenv = false;
    const exec = makeExec([
      { stdout: "" }, // python -m venv
      { stdout: "" }, // import mempalace (detect, empty → null)
      { stdout: "" }, // pip install
      { stdout: "3.3.2\n" }, // re-detect
    ]);
    const existsSyncImpl = vi.fn((_path: string) => pythonExistsAfterVenv);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: true,
      existsSyncImpl,
      isVenvImpl: () => true,
      execFileImpl: (async (cmd: string, args: string[]) => {
        const result = await (
          exec as unknown as (
            cmd: string,
            args: string[],
          ) => Promise<{ stdout: string; stderr?: string }>
        )(cmd, args);
        // After the venv step, the python binary "appears"
        if (args.includes("venv")) pythonExistsAfterVenv = true;
        return result;
      }) as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.version).toBe("3.3.2");
    expect(status.steps.some((s) => s.includes("creating venv"))).toBe(true);
    expect(status.steps.some((s) => s.includes("installing mempalace"))).toBe(
      true,
    );
  });

  it("upgrades when current version is below the floor", async () => {
    const exec = makeExec([
      { stdout: "3.3.1\n" }, // first detect → below floor
      { stdout: "" }, // pip install --upgrade
      { stdout: "3.3.2\n" }, // re-detect
    ]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: true,
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.version).toBe("3.3.2");
    expect(status.steps.some((s) => s.includes("upgrading mempalace"))).toBe(
      true,
    );
  });

  it("aligns to pinned target when autoInstall=true and current differs from target even if above floor", async () => {
    const exec = makeExec([
      { stdout: "3.4.0\n" }, // above floor but not equal to target (3.3.2)
      { stdout: "" }, // pip install (realign/downgrade)
      { stdout: "3.3.2\n" }, // re-detect
    ]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: true,
      installTarget: "3.3.2",
      minVersion: "3.3.2",
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.version).toBe("3.3.2");
    expect(status.steps.some((s) => s.includes("aligning mempalace"))).toBe(
      true,
    );
    expect(status.steps.some((s) => s.includes("was 3.4.0"))).toBe(true);
  });

  it("leaves off-target alone when autoInstall=false if above floor", async () => {
    const exec = makeExec([{ stdout: "3.4.0\n" }]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: false,
      installTarget: "3.3.2",
      minVersion: "3.3.2",
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.version).toBe("3.4.0");
    expect(status.steps.some((s) => s.includes("aligning"))).toBe(false);
  });

  it("no-op when already at the exact target (single exec call)", async () => {
    const exec = makeExec([{ stdout: "3.3.2\n" }]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: true,
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns actionable error when pip install fails", async () => {
    const exec = makeExec([
      { stdout: "" }, // first detect → null
      Object.assign(new Error("pip crash"), {
        stderr: "ERROR: No matching distribution",
      }),
    ]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: true,
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("pip install");
    expect(status.error).toContain("No matching distribution");
  });

  it("errors when install succeeds but version still below floor", async () => {
    const exec = makeExec([
      { stdout: "3.3.1\n" }, // first detect
      { stdout: "" }, // pip install (pretend it installed but wrong version)
      { stdout: "3.3.1\n" }, // re-detect still old
    ]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: true,
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("below the supported minimum");
  });

  it("respects custom minVersion / installTarget", async () => {
    const exec = makeExec([{ stdout: "4.0.0\n" }]);
    const status = await ensureMempalaceInstalled({
      pythonPath: venvPython,
      autoInstall: false,
      minVersion: "3.9.9",
      installTarget: "3.9.9",
      existsSyncImpl: () => true,
      isVenvImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
  });

  it("flags non-venv python in steps but still proceeds", async () => {
    const exec = makeExec([{ stdout: "3.3.2\n" }]);
    const status = await ensureMempalaceInstalled({
      pythonPath: "/usr/bin/python3",
      autoInstall: false,
      existsSyncImpl: () => true,
      isVenvImpl: () => false,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.steps.some((s) => s.includes("non-venv python"))).toBe(true);
  });
});
