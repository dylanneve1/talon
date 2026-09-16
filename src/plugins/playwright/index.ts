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
 *
 * VERSION COUPLING (endpoint mode): the WebSocket handshake requires the
 * client (playwright-core bundled inside @playwright/mcp) and the remote
 * browser server (e.g. the python-playwright process hosting Camoufox) to be
 * on the SAME playwright minor version — a mismatch fails every tool call
 * with "428 Precondition Required". @playwright/mcp is therefore pinned
 * exactly in package.json (0.0.56 → playwright 1.58.x, matching python
 * playwright 1.58 which hosts Camoufox — camoufox itself caps playwright at
 * <1.61, so the node client cannot chase latest). Bump BOTH sides together,
 * deliberately — do not let a routine dependency bump move one without the
 * other.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin/types.js";
import { files } from "../../util/paths.js";
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

  // Endpoint mode writes a config file the MCP child reads at every spawn;
  // `writeMcpConfig` is re-run before each spawn via `prepareMcpSpawn` so a
  // deleted config heals instead of failing every browser tool until restart.
  let writeMcpConfig: (() => void) | undefined;

  if (endpoint) {
    // Connect to the existing browser (e.g. the Camoufox websocket server)
    // via a generated MCP config file: `browser.remoteEndpoint` is the
    // stable, documented way to attach to a running Playwright server and —
    // unlike the newer `--endpoint` flag — exists across the @playwright/mcp
    // versions this repo can pin (the pin tracks the python playwright
    // version hosting Camoufox; see the version-coupling note above).
    const mcpConfig = {
      browser: {
        ...(browser !== "chromium" ? { browserName: browser } : {}),
        remoteEndpoint: endpoint,
      },
    };
    const configPath = files.playwrightMcpConfig;
    writeMcpConfig = () => {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(mcpConfig));
    };
    writeMcpConfig();
    args.push("--config", configPath);
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

    prepareMcpSpawn() {
      writeMcpConfig?.();
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
