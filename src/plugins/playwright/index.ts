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
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin.js";
import { log } from "../../util/log.js";

export function createPlaywrightPlugin(config: {
  browser?: string;
  headless?: boolean;
}): TalonPlugin {
  const browser = config.browser ?? "chromium";
  const headless = config.headless !== false; // default true

  // Resolve path from Talon's node_modules
  const mcpBin = resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/@playwright/mcp/cli.js",
  );

  const args = ["--no-sandbox"];

  if (headless) {
    args.push("--headless");
  }

  if (browser !== "chromium") {
    args.push("--browser", browser);
  }

  return {
    name: "playwright",
    description: "Browser automation via Playwright MCP (headless Chromium)",
    version: "1.0.0",

    mcpServer: {
      command: "node",
      args: [mcpBin, ...args],
    },

    validateConfig() {
      const errors: string[] = [];

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

      if (!existsSync(mcpBin)) {
        errors.push(
          `@playwright/mcp not found at ${mcpBin} — run "npm install @playwright/mcp"`,
        );
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      log("playwright", `Ready (${browser}, headless=${headless})`);
    },
  };
}
