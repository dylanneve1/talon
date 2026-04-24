/**
 * GitHub plugin — GitHub API access via the official GitHub MCP server.
 *
 * Enabling this plugin is sufficient to set it up. During init Talon pulls
 * the pinned `GITHUB_MCP_IMAGE` (always refreshed, to pick up digest
 * changes) and verifies it resolves.
 *
 * Configuration in ~/.talon/config.json:
 *   "github": {
 *     "enabled": true,
 *     "token": "ghp_..."      // optional — defaults to `gh auth token` output
 *     "image": "ghcr.io/..."  // advanced: override the pinned tag for testing
 *   }
 */

import { execFileSync } from "node:child_process";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { createProgressLogger } from "../common/progress.js";
import { runHeal } from "../common/lifecycle.js";
import { formatError } from "../common/errors.js";
import { GITHUB_MCP_IMAGE, createGithubHeal } from "./heal.js";

export { GITHUB_MCP_IMAGE } from "./heal.js";

/**
 * Resolve a GitHub personal access token. Priority: explicit config >
 * `gh auth token` CLI output. Absent token is not fatal — the github-mcp
 * server will surface 401s itself if the user somehow runs an API tool.
 */
function resolveToken(configToken?: string): string | undefined {
  const trimmed = configToken?.trim();
  if (trimmed) return trimmed;
  try {
    return execFileSync("gh", ["auth", "token"], {
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString("utf-8")
      .trim();
  } catch {
    return undefined;
  }
}

export interface CreateGitHubPluginConfig {
  token?: string;
  /** Advanced: override the pinned image tag. */
  image?: string;
}

export function createGitHubPlugin(
  config: CreateGitHubPluginConfig,
): TalonPlugin {
  const token = resolveToken(config.token);
  const image = config.image ?? GITHUB_MCP_IMAGE;

  return {
    name: "github",
    description: "GitHub API access via the official GitHub MCP server",
    version: "1.1.0",

    mcpServer: {
      command: "docker",
      args: ["run", "--rm", "-i", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", image],
    },

    validateConfig() {
      // Token is documented as optional (falls back to `gh auth token`), and
      // the upstream MCP server will surface its own 401 on authenticated
      // calls if nothing is set. Blocking plugin registration here would
      // make `{ "github": { "enabled": true } }` unusable without a token,
      // which contradicts the header docs — downgrade to a runtime warning.
      return undefined;
    },

    async init() {
      if (!token) {
        logWarn(
          "github",
          'no GitHub token found — set "token" in config or run `gh auth login`; API calls will 401 until fixed',
        );
      }
      const logger = createProgressLogger({ component: "github" });
      const result = await runHeal("github", createGithubHeal({ image }), {
        logger,
        totalTimeoutMs: 6 * 60_000,
      });

      switch (result.status) {
        case "healthy":
          log(
            "github",
            `ready — ${result.identifier} (heal ${Math.round(result.elapsedMs / 100) / 10}s)`,
          );
          return;
        case "degraded":
          logWarn("github", `starting degraded — ${result.identifier}`);
          if (result.error) logWarn("github", formatError(result.error));
          return;
        case "failed":
          logError(
            "github",
            `heal failed — MCP server spawn will likely fail. identifier=${result.identifier}`,
          );
          if (result.error) logError("github", formatError(result.error));
          return;
      }
    },

    getEnvVars() {
      return {
        ...(token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : {}),
      };
    },
  };
}
