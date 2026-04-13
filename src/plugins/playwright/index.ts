/**
 * Playwright plugin — browser automation via the official Playwright MCP server.
 *
 * Configuration in ~/.talon/config.json:
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "chromium",          // optional, default "chromium"
 *     "headless": true,               // optional, default true
 *     "dockerContainer": "camoufox-vpn" // optional, run MCP inside Docker container
 *   }
 *
 * When `dockerContainer` is set, the MCP server runs inside the container via
 * `docker exec -i`, connecting to Camoufox's local websocket. All browser
 * traffic routes through the container's network (e.g. NordVPN).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin.js";
import { log } from "../../util/log.js";

export function createPlaywrightPlugin(config: {
  browser?: string;
  headless?: boolean;
  dockerContainer?: string;
}): TalonPlugin {
  const browser = config.browser ?? "chromium";
  const headless = config.headless !== false; // default true
  const dockerContainer = config.dockerContainer;

  // Resolve path from Talon's node_modules
  const mcpBin = resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/@playwright/mcp/cli.js",
  );

  let command: string;
  let args: string[];

  if (dockerContainer) {
    // Run MCP server inside Docker container — connects to Camoufox locally
    command = "docker";
    args = ["exec", "-i", dockerContainer, "/app/mcp-bridge.sh"];
  } else {
    // Run MCP server locally
    command = "node";
    args = [mcpBin, "--no-sandbox"];

    if (headless) {
      args.push("--headless");
    }

    if (browser !== "chromium") {
      args.push("--browser", browser);
    }
  }

  const description = dockerContainer
    ? `Browser automation via Playwright MCP (Docker: ${dockerContainer})`
    : `Browser automation via Playwright MCP (headless ${browser})`;

  return {
    name: "playwright",
    description,
    version: "1.0.0",

    mcpServer: {
      command,
      args,
    },

    validateConfig() {
      const errors: string[] = [];

      if (!dockerContainer) {
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
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      if (dockerContainer) {
        log("playwright", `Ready (Docker container: ${dockerContainer})`);
      } else {
        log("playwright", `Ready (${browser}, headless=${headless})`);
      }
    },
  };
}
