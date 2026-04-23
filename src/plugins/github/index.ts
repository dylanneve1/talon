/**
 * GitHub plugin — GitHub API access via the official GitHub MCP server.
 *
 * Registers the GitHub MCP server (Docker image: pinned by GITHUB_MCP_IMAGE),
 * giving the agent access to repository management, issues, PRs, code search, etc.
 *
 * Configuration in ~/.talon/config.json:
 *   "github": {
 *     "enabled": true,
 *     "token": "ghp_...",     // optional, defaults to `gh auth token` output
 *     "autoPull": true,       // optional, docker pull the pinned image on init
 *     "image": "ghcr.io/..."  // optional, advanced override of the pinned tag
 *   }
 */

import { execFileSync } from "node:child_process";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { GITHUB_MCP_IMAGE, ensureGithubMcpAvailable } from "./install.js";

export { GITHUB_MCP_IMAGE } from "./install.js";

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

export function createGitHubPlugin(config: {
  token?: string;
  /**
   * If true, `docker pull` the pinned image during init when it's missing.
   * Default false — we don't move 200MB+ onto the user's disk without consent.
   */
  autoPull?: boolean;
  /**
   * Advanced: override the pinned image tag. Use only for testing; normal
   * upgrades bump {@link GITHUB_MCP_IMAGE} so CI covers the new version.
   */
  image?: string;
}): TalonPlugin {
  const token = resolveToken(config.token);
  const image = config.image ?? GITHUB_MCP_IMAGE;
  const autoPull = config.autoPull === true;

  return {
    name: "github",
    description: "GitHub API access via the official GitHub MCP server",
    version: "1.0.0",

    mcpServer: {
      command: "docker",
      args: ["run", "--rm", "-i", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", image],
    },

    validateConfig() {
      const errors: string[] = [];

      if (!token) {
        errors.push(
          'No GitHub token found. Set "token" in github config or run `gh auth login`.',
        );
      }

      // Check Docker is available — synchronous fast-fail check. The image
      // presence / version check is deferred to async init() so we don't
      // block startup for a pull.
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
      const status = await ensureGithubMcpAvailable({
        autoPull,
        image,
      });
      for (const step of status.steps) log("github", step);
      if (!status.ok) {
        if (autoPull) {
          logError(
            "github",
            status.error ?? "github MCP ensureAvailable failed",
          );
        } else {
          logWarn(
            "github",
            status.error ??
              `Docker image ${image} not present — will pull on first use (may be slow). Set github.autoPull=true to pull at startup.`,
          );
        }
      }
      log("github", `Ready [${image}]`);
    },

    getEnvVars() {
      return {
        ...(token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : {}),
      };
    },
  };
}
