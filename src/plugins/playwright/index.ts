/**
 * Playwright plugin — browser automation via the official Playwright MCP server.
 *
 * Gives the agent headless Chromium for web scraping, screenshots, PDF generation,
 * and general browser automation.
 *
 * Configuration in ~/.talon/config.json:
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "chromium",     // optional, default "chromium"
 *     "headless": true           // optional, default true
 *   }
 *
 * For Camoufox (anti-detect browser):
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "firefox",
 *     "endpointFile": "/home/dylan/camoufox-endpoint.txt"
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin.js";
import { log } from "../../util/log.js";

export function createPlaywrightPlugin(config: {
  browser?: string;
  headless?: boolean;
  endpoint?: string;
  endpointFile?: string;
}): TalonPlugin {
  const browser = config.browser ?? "chromium";
  const headless = config.headless !== false; // default true

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
        const validBrowsers = [
          "chromium",
          "chrome",
          "firefox",
          "webkit",
          "msedge",
        ];
        if (!validBrowsers.includes(browser)) {
          errors.push(
            `Invalid browser "${browser}". Valid options: ${validBrowsers.join(", ")}`,
          );
        }
      }

      if (!existsSync(mcpBin)) {
        errors.push(
          `@playwright/mcp not found at ${mcpBin} — run "npm install @playwright/mcp"`,
        );
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      log(
        "playwright",
        `Ready (${endpoint ? `Camoufox @ ${endpoint}` : `${browser}, headless=${headless}`})`,
      );
    },
  };
}
