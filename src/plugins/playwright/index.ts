/**
 * Playwright plugin — browser automation via the official Playwright MCP server.
 *
 * Enabling this plugin is sufficient to set it up. During init Talon
 * verifies `@playwright/mcp` matches the pinned version, probes the
 * configured browser binary, and downloads it via
 * `npx playwright install <browser>` if missing.
 *
 * Configuration in ~/.talon/config.json:
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "chromium",       // optional, default "chromium"
 *     "headless": true             // optional, default true
 *   }
 *
 * For a remote browser (bring-your-own-CDP, anti-detect browser, etc.):
 *   "playwright": {
 *     "enabled": true,
 *     "browser": "firefox",
 *     "endpointFile": "/path/to/endpoint.txt"
 *   }
 *
 * When an endpoint is configured Talon skips the local browser install —
 * there's nothing to download for a remote-driven session.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { createProgressLogger } from "../common/progress.js";
import { runHeal } from "../common/lifecycle.js";
import { formatError } from "../common/errors.js";
import {
  PLAYWRIGHT_MCP_VERSION,
  SUPPORTED_BROWSERS,
  createPlaywrightHeal,
  type SupportedBrowser,
} from "./heal.js";

export { PLAYWRIGHT_MCP_VERSION, SUPPORTED_BROWSERS } from "./heal.js";
export type { SupportedBrowser } from "./heal.js";

export interface CreatePlaywrightPluginConfig {
  browser?: string;
  headless?: boolean;
  endpoint?: string;
  endpointFile?: string;
}

export function createPlaywrightPlugin(
  config: CreatePlaywrightPluginConfig,
): TalonPlugin {
  // Zod allows `browser: ""` through as a string; treat blank/whitespace as
  // unset so the default applies instead of silently failing validation for
  // the most common misconfiguration (empty string from a template or env).
  const trimmedBrowser = config.browser?.trim();
  const browserName =
    trimmedBrowser && trimmedBrowser.length > 0 ? trimmedBrowser : "chromium";
  const headless = config.headless !== false;

  // Resolve endpoint: direct value or read-from-file.
  let endpoint = config.endpoint;
  if (!endpoint && config.endpointFile) {
    try {
      endpoint = readFileSync(config.endpointFile, "utf-8").trim();
    } catch (err) {
      const detail =
        err instanceof Error
          ? `${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`.trim()
          : String(err);
      logWarn(
        "playwright",
        `could not read endpoint file ${config.endpointFile} (${detail}) — continuing without endpoint`,
      );
    }
  }

  // Locate the MCP CLI inside Talon's node_modules.
  const mcpBin = resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/@playwright/mcp/cli.js",
  );

  const browserKnown = (SUPPORTED_BROWSERS as readonly string[]).includes(
    browserName,
  );

  const serverArgs: string[] = [];
  if (endpoint) {
    serverArgs.push("--endpoint", endpoint);
  } else {
    serverArgs.push("--no-sandbox");
    if (headless) serverArgs.push("--headless");
    if (browserName !== "chromium") serverArgs.push("--browser", browserName);
  }

  return {
    name: "playwright",
    description: `Browser automation via Playwright MCP (${endpoint ? "remote endpoint" : browserName})`,
    version: "1.1.0",

    mcpServer: {
      command: "node",
      args: [mcpBin, ...serverArgs],
    },

    validateConfig() {
      // Consistent with mempalace/github: don't block plugin registration
      // for anything heal() can diagnose and classify with better context.
      // The only thing we fail here is an outright invalid browser name —
      // heal can't recover from that, and it's deterministic from config
      // alone (no IO needed). Missing @playwright/mcp and browser binary
      // states are reported through heal's structured PluginError path.
      if (!endpoint && !browserKnown) {
        return [
          `invalid browser "${browserName}". valid options: ${SUPPORTED_BROWSERS.join(", ")}`,
        ];
      }
      return undefined;
    },

    async init() {
      const logger = createProgressLogger({ component: "playwright" });
      const result = await runHeal(
        "playwright",
        createPlaywrightHeal({
          mcpBin,
          browser: endpoint
            ? undefined
            : browserKnown
              ? (browserName as SupportedBrowser)
              : undefined,
        }),
        { logger, totalTimeoutMs: 12 * 60_000 },
      );

      const contextSuffix = endpoint
        ? ` (endpoint: ${endpoint})`
        : ` (${browserName}, headless=${headless})`;

      switch (result.status) {
        case "healthy":
          log(
            "playwright",
            `ready — ${result.identifier}${contextSuffix} (heal ${Math.round(result.elapsedMs / 100) / 10}s, pinned @playwright/mcp ${PLAYWRIGHT_MCP_VERSION})`,
          );
          return;
        case "degraded":
          logWarn(
            "playwright",
            `starting degraded — ${result.identifier}${contextSuffix}`,
          );
          if (result.error) logWarn("playwright", formatError(result.error));
          return;
        case "failed":
          logError(
            "playwright",
            `heal failed — MCP server will still spawn but expect errors. identifier=${result.identifier}${contextSuffix}`,
          );
          if (result.error) logError("playwright", formatError(result.error));
          return;
      }
    },
  };
}
