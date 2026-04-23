/**
 * Playwright MCP onboarding + sanity checks.
 *
 * @playwright/mcp is bundled via package.json. Separate from the npm pin,
 * Playwright browser binaries live outside node_modules (chromium, firefox,
 * webkit — hundreds of MB each, installed via `playwright install`). This
 * helper:
 *   - Exposes the Talon-supported @playwright/mcp version (PLAYWRIGHT_MCP_VERSION)
 *   - Verifies the npm package is resolvable at the MCP CLI path
 *   - Verifies the chosen browser binary is present, optionally runs
 *     `npx playwright install <browser>` to download it
 *   - Surfaces actionable errors when any step fails
 *
 * Bump PLAYWRIGHT_MCP_VERSION + the package.json pin together when the
 * plugin has been tested and verified against a newer upstream release.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/**
 * Pinned @playwright/mcp version. Must match the pin in package.json
 * (`"@playwright/mcp": "<version>"`). Keep in sync on upgrade.
 *
 * @see https://github.com/microsoft/playwright-mcp/releases
 */
export const PLAYWRIGHT_MCP_VERSION = "0.0.70";

/** Browsers Playwright can automate, mapped to canonical `playwright install` names. */
export const SUPPORTED_BROWSERS = [
  "chromium",
  "chrome",
  "firefox",
  "webkit",
  "msedge",
] as const;

export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export type InstallStatus = {
  /** True when the MCP CLI is resolvable and (if checked) the browser is installed. */
  ok: boolean;
  /** Detected installed @playwright/mcp version, or null if not resolvable. */
  version: string | null;
  /** Browser checked (if any). */
  browser?: SupportedBrowser;
  /** Human-readable steps taken during this ensure() call. */
  steps: string[];
  /** Populated when ok=false — actionable error for the user. */
  error?: string;
};

export type EnsureOptions = {
  /** Absolute path to `@playwright/mcp/cli.js`. */
  mcpBin: string;
  /**
   * Browser to verify. When provided, a missing browser triggers a
   * `playwright install` if {@link installBrowsers} is true.
   * Omit when using a remote `endpoint` — no local browser needed.
   */
  browser?: SupportedBrowser;
  /**
   * If true, missing browser binaries trigger `npx playwright install <browser>`.
   * When false, the function only diagnoses and returns an error.
   */
  installBrowsers: boolean;
  /** Timeout for each subprocess call, ms. Default 300s — browser install can be slow. */
  timeoutMs?: number;
  /** Expected @playwright/mcp version. Defaults to {@link PLAYWRIGHT_MCP_VERSION}. */
  expectedVersion?: string;
  /** Injected for tests — defaults to Node's promisified execFile. */
  execFileImpl?: typeof execFile;
  /** Injected for tests — defaults to fs.existsSync. */
  existsSyncImpl?: (path: string) => boolean;
};

/**
 * Read `@playwright/mcp/package.json` adjacent to the CLI to report the
 * installed version. Returns null if anything fails.
 */
export function detectMcpVersion(mcpBin: string): string | null {
  try {
    // mcpBin is typically .../node_modules/@playwright/mcp/cli.js
    // → .../node_modules/@playwright/mcp/package.json
    const pkgJson = pathResolve(dirname(mcpBin), "package.json");
    if (!existsSync(pkgJson)) return null;
    const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure @playwright/mcp is installed and (optionally) the chosen browser
 * binary is available.
 *
 * When installBrowsers=true this is self-healing: missing browser →
 * `npx playwright install <browser>`. When false the function only diagnoses.
 */
export async function ensurePlaywrightMcpAvailable(
  opts: EnsureOptions,
): Promise<InstallStatus> {
  const {
    mcpBin,
    browser,
    installBrowsers,
    timeoutMs = 300_000,
    expectedVersion = PLAYWRIGHT_MCP_VERSION,
    execFileImpl = execFile,
    existsSyncImpl = existsSync,
  } = opts;

  const steps: string[] = [];

  // 1. CLI present?
  if (!existsSyncImpl(mcpBin)) {
    return {
      ok: false,
      version: null,
      browser,
      steps,
      error: `@playwright/mcp not found at ${mcpBin} — run "npm install" in the Talon checkout.`,
    };
  }
  steps.push(`@playwright/mcp CLI present: ${mcpBin}`);

  // 2. Version matches pin?
  const version = detectMcpVersion(mcpBin);
  if (version && version !== expectedVersion) {
    steps.push(
      `@playwright/mcp ${version} (expected ${expectedVersion}) — run 'npm install' to align`,
    );
  } else if (version) {
    steps.push(`@playwright/mcp ${version} matches pin`);
  }

  // 3. Browser check (optional — when using remote endpoint there is no
  //    local browser to verify).
  if (browser) {
    if (!SUPPORTED_BROWSERS.includes(browser)) {
      return {
        ok: false,
        version,
        browser,
        steps,
        error: `Invalid browser "${browser}". Valid: ${SUPPORTED_BROWSERS.join(", ")}`,
      };
    }

    const browserOk = await isBrowserInstalled(browser, execFileImpl);
    if (!browserOk) {
      if (!installBrowsers) {
        return {
          ok: false,
          version,
          browser,
          steps,
          error: `Playwright browser "${browser}" is not installed. Run: npx playwright install ${browser} — or set playwright.installBrowsers=true to do it automatically.`,
        };
      }
      steps.push(`installing playwright browser: ${browser}`);
      try {
        await execFileImpl("npx", ["playwright", "install", browser], {
          timeout: timeoutMs,
        });
      } catch (err) {
        const stderr = (err as { stderr?: string | Buffer }).stderr ?? "";
        const stderrText =
          typeof stderr === "string"
            ? stderr
            : Buffer.isBuffer(stderr)
              ? stderr.toString("utf-8")
              : "";
        return {
          ok: false,
          version,
          browser,
          steps,
          error: `npx playwright install ${browser} failed: ${(err as Error).message}${stderrText ? ` — ${stderrText.trim().slice(0, 400)}` : ""}`,
        };
      }
      if (!(await isBrowserInstalled(browser, execFileImpl))) {
        return {
          ok: false,
          version,
          browser,
          steps,
          error: `playwright install ${browser} claimed success but the browser is still not detectable via 'playwright install --dry-run'.`,
        };
      }
      steps.push(`browser installed: ${browser}`);
    } else {
      steps.push(`browser present: ${browser}`);
    }
  }

  return { ok: true, version, browser, steps };
}

/**
 * Detect whether a Playwright browser is installed by asking
 * `playwright install --dry-run`, which lists what *would* be installed.
 * If the browser is missing the command exits non-zero or prints a "will
 * download" line. We only trust "is already installed" markers.
 */
async function isBrowserInstalled(
  browser: SupportedBrowser,
  execFileImpl: typeof execFile,
): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileImpl(
      "npx",
      ["playwright", "install", "--dry-run", browser],
      { timeout: 30_000 },
    );
    const combined = `${stdout}\n${stderr}`.toLowerCase();
    if (
      combined.includes("downloading") ||
      combined.includes("will download") ||
      combined.includes("not found")
    ) {
      return false;
    }
    // playwright prints "browser: chromium ... Install location: ..." when installed
    return combined.includes(browser.toLowerCase());
  } catch {
    return false;
  }
}
