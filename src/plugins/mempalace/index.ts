/**
 * MemPalace plugin — structured long-term memory with vector search.
 *
 * Enabling this plugin is sufficient to set it up. During init() Talon
 * will create the Python venv at `~/.talon/mempalace-venv/`, install
 * mempalace at the pinned version, and verify the MCP server submodule
 * is importable. No opt-in flag — if you want mempalace, set `enabled: true`.
 *
 * Configuration in ~/.talon/config.json:
 *   "mempalace": {
 *     "enabled": true,
 *     "palacePath": "/path/to/palace",         // optional, default ~/.talon/workspace/palace/
 *     "pythonPath": "/path/to/python",         // optional — supplying this disables self-heal (verify-only mode)
 *     "entityLanguages": ["en", "ja"],         // optional, BCP 47 codes (mempalace >= 3.3.2)
 *     "verbose": false                          // optional, sets MEMPAL_VERBOSE=1 for diagnostic diaries
 *   }
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { dirs, files as pathFiles } from "../../util/paths.js";
import { createProgressLogger } from "../common/progress.js";
import { runHeal } from "../common/lifecycle.js";
import { formatError } from "../common/errors.js";
import {
  MEMPALACE_TARGET,
  MEMPALACE_FLOOR,
  createMempalaceHeal,
} from "./heal.js";

export { MEMPALACE_TARGET, MEMPALACE_FLOOR } from "./heal.js";

const PROMPT_PATH = resolve(dirs.prompts, "mempalace.md");

export interface CreateMempalacePluginConfig {
  pythonPath?: string;
  palacePath: string;
  entityLanguages?: readonly string[];
  verbose?: boolean;
}

/**
 * Resolve the plugin's Python path + ownership semantics.
 *
 * The ownership bit ("managed") is the safety rail for self-heal:
 * we only invoke pip when the pythonPath came from our default
 * (i.e. we created and own the venv). If the user pointed at a
 * custom interpreter we probe but never mutate.
 */
function resolvePython(config: CreateMempalacePluginConfig): {
  pythonPath: string;
  managed: boolean;
} {
  if (config.pythonPath && config.pythonPath.trim().length > 0) {
    return { pythonPath: config.pythonPath, managed: false };
  }
  return { pythonPath: pathFiles.mempalacePython, managed: true };
}

export function createMempalacePlugin(
  config: CreateMempalacePluginConfig,
): TalonPlugin {
  const { pythonPath, managed } = resolvePython(config);
  const palacePath = config.palacePath;
  const entityLanguages = config.entityLanguages;
  const verbose = config.verbose;

  const envVars: Record<string, string> = {
    MEMPALACE_PALACE_PATH: palacePath,
  };
  if (entityLanguages && entityLanguages.length > 0) {
    envVars.MEMPALACE_ENTITY_LANGUAGES = entityLanguages.join(",");
  }
  if (verbose) {
    envVars.MEMPAL_VERBOSE = "1";
  }

  return {
    name: "mempalace",
    description:
      "Memory palace — structured long-term memory with vector search",
    version: "1.2.0",

    mcpServer: {
      command: pythonPath,
      args: ["-m", "mempalace.mcp_server", "--palace", palacePath],
    },

    validateConfig() {
      // Heal handles installability; validateConfig only fails the
      // synchronous prerequisites that heal cannot fix (obviously bad
      // paths). Runtime failures go through heal → structured log.
      return undefined;
    },

    async init() {
      if (!existsSync(palacePath)) {
        mkdirSync(palacePath, { recursive: true });
        log("mempalace", `palace directory: ${palacePath} (created)`);
      }

      const logger = createProgressLogger({ component: "mempalace" });
      const result = await runHeal(
        "mempalace",
        createMempalaceHeal({ pythonPath, managed }),
        { logger, totalTimeoutMs: 8 * 60_000 },
      );

      const langSuffix =
        entityLanguages && entityLanguages.length > 0
          ? ` (entity languages: ${entityLanguages.join(",")})`
          : "";

      switch (result.status) {
        case "healthy":
          log(
            "mempalace",
            `ready — ${result.identifier}${langSuffix} (heal ${
              Math.round(result.elapsedMs / 100) / 10
            }s)`,
          );
          return;
        case "degraded":
          logWarn(
            "mempalace",
            `starting in degraded mode — ${result.identifier}${langSuffix}`,
          );
          if (result.error) logWarn("mempalace", formatError(result.error));
          return;
        case "failed":
          logError(
            "mempalace",
            `heal failed — MCP server will still spawn but expect errors. identifier=${result.identifier}${langSuffix}`,
          );
          if (result.error) logError("mempalace", formatError(result.error));
          return;
      }
    },

    getEnvVars() {
      return { ...envVars };
    },

    getSystemPromptAddition() {
      const languagesLine =
        entityLanguages && entityLanguages.length > 0
          ? entityLanguages.join(", ")
          : "en (default)";
      try {
        const template = readFileSync(PROMPT_PATH, "utf-8");
        return template
          .replace(/\{\{palacePath\}\}/g, palacePath)
          .replace(/\{\{entityLanguages\}\}/g, languagesLine);
      } catch (err) {
        logWarn(
          "mempalace",
          `failed to load prompt from ${PROMPT_PATH}: ${err instanceof Error ? err.message : err}`,
        );
        return `## MemPalace — Long-term Memory\n\nPalace location: \`${palacePath}\`\nEntity languages: ${languagesLine}`;
      }
    },
  };
}
