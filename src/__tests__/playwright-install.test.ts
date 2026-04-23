import { describe, it, expect, vi } from "vitest";
import {
  PLAYWRIGHT_MCP_VERSION,
  SUPPORTED_BROWSERS,
  ensurePlaywrightMcpAvailable,
} from "../plugins/playwright/install.js";

describe("PLAYWRIGHT_MCP_VERSION", () => {
  it("is a pinned semver", () => {
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("SUPPORTED_BROWSERS", () => {
  it("includes the canonical Playwright browsers", () => {
    expect(SUPPORTED_BROWSERS).toEqual([
      "chromium",
      "chrome",
      "firefox",
      "webkit",
      "msedge",
    ]);
  });
});

describe("ensurePlaywrightMcpAvailable", () => {
  function queueExec(
    responses: Array<{ stdout?: string; stderr?: string } | Error>,
  ) {
    return vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected exec call (no response queued)");
      if (next instanceof Error) throw next;
      return { stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
    });
  }

  it("errors when the MCP CLI is missing", async () => {
    const exec = queueExec([]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      installBrowsers: false,
      existsSyncImpl: () => false,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("@playwright/mcp not found");
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports ok when no browser check is requested (remote endpoint mode)", async () => {
    const exec = queueExec([]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      installBrowsers: false,
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("errors with an actionable message when installed CLI version doesn't match the pin", async () => {
    // Need a real file so detectMcpVersion can read adjacent package.json.
    // Simulate by pointing mcpBin at the node_modules/@playwright/mcp/cli.js
    // but override expectedVersion to something we don't have installed.
    const exec = queueExec([]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin:
        "/home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js",
      installBrowsers: false,
      expectedVersion: "99.99.99",
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("Talon pins 99.99.99");
    expect(status.error).toContain("npm install");
  });

  it("errors for unsupported browser names", async () => {
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      browser: "safari" as never,
      installBrowsers: false,
      existsSyncImpl: () => true,
      execFileImpl: (() => {
        throw new Error("should not be called");
      }) as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("Invalid browser");
  });

  it("reports ok when browser is detected as installed", async () => {
    const exec = queueExec([
      { stdout: "browser: chromium\nInstall location: /home/x/.cache" },
    ]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      browser: "chromium",
      installBrowsers: false,
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
  });

  it("errors without installing when installBrowsers=false and browser is missing", async () => {
    const exec = queueExec([{ stdout: "downloading chromium 0MB / 120MB" }]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      browser: "chromium",
      installBrowsers: false,
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("not installed");
    expect(status.error).toContain("installBrowsers=true");
  });

  it("installs the browser when installBrowsers=true and reports ok", async () => {
    const exec = queueExec([
      { stdout: "downloading chromium" }, // first dry-run: missing
      { stdout: "installed" }, // actual install
      { stdout: "browser: chromium\nInstall location: /home/x/.cache" }, // re-check
    ]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      browser: "chromium",
      installBrowsers: true,
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(true);
    expect(status.steps.some((s) => s.includes("installing playwright"))).toBe(
      true,
    );
    expect(status.steps.some((s) => s.includes("browser installed"))).toBe(
      true,
    );
  });

  it("surfaces install failure with useful error", async () => {
    const exec = queueExec([
      { stdout: "downloading chromium" },
      Object.assign(new Error("install crashed"), {
        stderr: "Network unreachable",
      }),
    ]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      browser: "chromium",
      installBrowsers: true,
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("playwright install chromium failed");
    expect(status.error).toContain("Network unreachable");
  });

  it("errors when install succeeds but browser still missing", async () => {
    const exec = queueExec([
      { stdout: "downloading chromium" },
      { stdout: "installed" },
      { stdout: "downloading chromium again" }, // still not installed
    ]);
    const status = await ensurePlaywrightMcpAvailable({
      mcpBin: "/fake/cli.js",
      browser: "chromium",
      installBrowsers: true,
      existsSyncImpl: () => true,
      execFileImpl: exec as unknown as never,
    });
    expect(status.ok).toBe(false);
    expect(status.error).toContain("claimed success");
  });
});
