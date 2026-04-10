/**
 * GitHub plugin — GitHub API access via the official GitHub MCP server.
 *
 * Registers the GitHub MCP server (Docker image: ghcr.io/github/github-mcp-server),
 * giving the agent access to repository management, issues, PRs, code search, etc.
 *
 * Configuration in ~/.talon/config.json:
 *   "github": {
 *     "enabled": true,
 *     "token": "ghp_..."      // optional, defaults to `gh auth token` output
 *   }
 */

import { execFileSync } from "node:child_process";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logWarn } from "../../util/log.js";

/**
 * Resolve a GitHub personal access token.
 * Priority: explicit config > `gh auth token` CLI.
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

export function createGitHubPlugin(config: { token?: string }): TalonPlugin {
  const token = resolveToken(config.token);

  return {
    name: "github",
    description: "GitHub API access via the official GitHub MCP server",
    version: "1.0.0",

    mcpServer: {
      command: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server",
      ],
    },

    validateConfig() {
      const errors: string[] = [];

      if (!token) {
        errors.push(
          'No GitHub token found. Set "token" in github config or run `gh auth login`.',
        );
      }

      // Check Docker is available
      try {
        execFileSync("docker", ["info"], {
          timeout: 10_000,
          stdio: "pipe",
        });
      } catch {
        errors.push(
          "Docker is not available or not running. The GitHub MCP server requires Docker.",
        );
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      // Verify the Docker image exists locally
      try {
        execFileSync(
          "docker",
          ["image", "inspect", "ghcr.io/github/github-mcp-server"],
          { timeout: 10_000, stdio: "pipe" },
        );
        log("github", "Docker image verified");
      } catch {
        logWarn(
          "github",
          "Docker image not found locally — will pull on first use (may be slow)",
        );
      }

      log("github", "Ready");
    },

    getEnvVars() {
      return {
        ...(token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : {}),
      };
    },
  };
}
