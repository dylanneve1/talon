import { describe, it, expect } from "vitest";
import {
  classifySubprocessError,
  formatError,
  unknownError,
} from "../../../plugins/common/errors.js";

/**
 * These tests matter because classification drives the user-facing hint
 * line in the log. Misclassifying a network error as "unknown" strips
 * the actionable "check internet" guidance — users end up staring at
 * raw pip stderr. The match patterns are derived from actual failure
 * output we've seen on CI and local runs; any new pattern we want to
 * classify should get a regression test here.
 */

const baseInput = {
  program: "pip",
  args: ["install"] as readonly string[],
  exitCode: 1,
  signal: null as NodeJS.Signals | null,
  stdout: "",
  stderr: "",
};

describe("classifySubprocessError — spawn errors have priority", () => {
  it("ENOENT from spawn → executable-not-found with actionable hint", () => {
    const err = classifySubprocessError({
      ...baseInput,
      spawnError: Object.assign(new Error("spawn ENOENT"), {
        code: "ENOENT",
      }) as NodeJS.ErrnoException,
    });
    expect(err.kind).toBe("executable-not-found");
    expect(err.hint).toContain("install");
  });

  it("EACCES / EPERM → permission", () => {
    for (const code of ["EACCES", "EPERM"] as const) {
      const err = classifySubprocessError({
        ...baseInput,
        spawnError: Object.assign(new Error(`fail ${code}`), {
          code,
        }) as NodeJS.ErrnoException,
      });
      expect(err.kind).toBe("permission");
    }
  });

  it("signal kill without exit → timeout", () => {
    const err = classifySubprocessError({
      ...baseInput,
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(err.kind).toBe("timeout");
  });
});

describe("classifySubprocessError — pattern matching on stderr", () => {
  it("disk space exhaustion (pip or docker)", () => {
    const err = classifySubprocessError({
      ...baseInput,
      stderr: "OSError: [Errno 28] No space left on device",
    });
    expect(err.kind).toBe("disk-space");
  });

  it("DNS / connectivity failures", () => {
    for (const stderr of [
      "Could not resolve host: pypi.org",
      "getaddrinfo EAI_AGAIN registry.npmjs.org",
      "connection refused while pulling image",
      "Temporary failure in name resolution",
    ]) {
      const err = classifySubprocessError({ ...baseInput, stderr });
      expect(err.kind).toBe("network");
    }
  });

  it("upstream package/image missing (pip + docker + npm variants)", () => {
    for (const stderr of [
      "ERROR: No matching distribution found for mempalace==9.9.9",
      "error: No matching manifest for linux/amd64 in manifest list",
      "manifest unknown: manifest unknown",
      "404 Not Found: /v2/github/github-mcp-server/manifests/v999",
    ]) {
      const err = classifySubprocessError({ ...baseInput, stderr });
      expect(err.kind).toBe("upstream-unavailable");
    }
  });

  it("stderr 'permission denied' at runtime → permission", () => {
    const err = classifySubprocessError({
      ...baseInput,
      stderr:
        "PermissionError: [Errno 13] Permission denied: '/usr/local/lib/python3.12/site-packages'",
    });
    expect(err.kind).toBe("permission");
  });

  it("falls through to 'unknown' when nothing matches", () => {
    const err = classifySubprocessError({
      ...baseInput,
      exitCode: 2,
      stderr: "Something we've never seen before",
    });
    expect(err.kind).toBe("unknown");
    expect(err.message).toContain("exit 2");
  });

  it("preserves the last 3 lines of stderr in details for post-mortem", () => {
    const stderr = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const err = classifySubprocessError({
      ...baseInput,
      exitCode: 1,
      stderr,
    });
    expect(err.details).toBe("line 7\nline 8\nline 9");
  });
});

describe("formatError", () => {
  it("emits a single line when no details are present", () => {
    const err = unknownError("x failed", "retry");
    expect(formatError(err)).toBe("[unknown] x failed — retry");
  });

  it("indents details onto following lines so logs stay aligned", () => {
    const err = classifySubprocessError({
      ...baseInput,
      exitCode: 1,
      stderr: "line1\nline2",
    });
    const formatted = formatError(err);
    expect(formatted.split("\n")[0]).toMatch(/^\[unknown\]/);
    expect(formatted).toContain("    line1");
    expect(formatted).toContain("    line2");
  });
});
