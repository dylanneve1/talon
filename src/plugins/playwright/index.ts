/**
 * Playwright plugin — browser automation via the official Playwright MCP server.
 *
 * Gives the agent headless Chromium for web scraping, screenshots, PDF generation,
 * and general browser automation.
 *
 * Configuration in ~/.talon/config.json:
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "chromium",       // optional, default "chromium"
 *     "headless": true,            // optional, default true
 *     "installBrowsers": true       // optional, auto-download browser binaries on init
 *   }
 *
 * For Camoufox / remote browser (no local binary needed):
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "firefox",
 *     "endpointFile": "/home/dylan/camoufox-endpoint.txt"
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import {
  PLAYWRIGHT_MCP_VERSION,
  SUPPORTED_BROWSERS,
  ensurePlaywrightMcpAvailable,
  type SupportedBrowser,
} from "./install.js";

export { PLAYWRIGHT_MCP_VERSION, SUPPORTED_BROWSERS } from "./install.js";

export function createPlaywrightPlugin(config: {
  browser?: string;
  headless?: boolean;
  endpoint?: string;
  endpointFile?: string;
  /**
   * When true, init() downloads the selected browser via
   * `npx playwright install <browser>` if it's not already present.
   * Default false — browser binaries are hundreds of MB and we don't
   * touch the user's disk without consent.
   */
  installBrowsers?: boolean;
}): TalonPlugin {
  const browser = config.browser ?? "chromium";
  const headless = config.headless !== false; // default true
  const installBrowsers = config.installBrowsers === true;

  // Resolve endpoint: direct string or read from file
  let endpoint = config.endpoint;
  if (!endpoint && config.endpointFile) {
    try {
      endpoint = readFileSync(config.endpointFile, "utf-8").trim();
    } catch {
      log(
        "playwright",
        `Warning: could not read endpoint file ${config.endpointFile}`,
      );
    }
  }

  // Resolve path from Talon's node_modules
  const mcpBin = resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/@playwright/mcp/cli.js",
  );

  const args: string[] = [];

  if (endpoint) {
    // Connect to existing browser (e.g. Camoufox websocket server)
    args.push("--endpoint", endpoint);
  } else {
    args.push("--no-sandbox");

    if (headless) {
      args.push("--headless");
    }

    if (browser !== "chromium") {
      args.push("--browser", browser);
    }
  }

  return {
    name: "playwright",
    description: `Browser automation via Playwright MCP (${endpoint ? "Camoufox" : browser})`,
    version: "1.0.0",

    mcpServer: {
      command: "node",
      args: [mcpBin, ...args],
    },

    validateConfig() {
      const errors: string[] = [];

      if (!endpoint) {
        if (!(SUPPORTED_BROWSERS as readonly string[]).includes(browser)) {
          errors.push(
            `Invalid browser "${browser}". Valid options: ${SUPPORTED_BROWSERS.join(", ")}`,
          );
        }
      }

      if (!existsSync(mcpBin)) {
        errors.push(
          `@playwright/mcp not found at ${mcpBin} — run "npm install" in the Talon checkout.`,
        );
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      // Skip browser check when using a remote endpoint — no local binary
      // needed. CLI presence / version pin is always checked.
      const checkBrowser =
        !endpoint && (SUPPORTED_BROWSERS as readonly string[]).includes(browser)
          ? (browser as SupportedBrowser)
          : undefined;
      const status = await ensurePlaywrightMcpAvailable({
        mcpBin,
        browser: checkBrowser,
        installBrowsers,
      });
      for (const step of status.steps) log("playwright", step);
      if (!status.ok) {
        if (installBrowsers) {
          logError(
            "playwright",
            status.error ?? "playwright ensureAvailable failed",
          );
        } else {
          logWarn(
            "playwright",
            status.error ??
              "playwright browser not installed — set playwright.installBrowsers=true to auto-download",
          );
        }
      }
      const versionSuffix = status.version
        ? ` [@playwright/mcp ${status.version}]`
        : "";
      log(
        "playwright",
        `Ready (${endpoint ? `remote @ ${endpoint}` : `${browser}, headless=${headless}`})${versionSuffix}`,
      );
    },
  };
}
