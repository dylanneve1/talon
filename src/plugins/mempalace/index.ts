/**
 * MemPalace plugin — structured long-term memory with vector search.
 *
 * Registers the mempalace Python MCP server, giving the agent access to
 * semantic memory search, knowledge graph operations, and diary entries.
 *
 * Configuration in ~/.talon/config.json:
 *   "mempalace": {
 *     "enabled": true,
 *     "palacePath": "/path/to/palace",         // optional, defaults to ~/.talon/workspace/palace/
 *     "pythonPath": "/path/to/python",         // optional, defaults to mempalace venv python (bin/python on Unix, Scripts/python.exe on Windows)
 *     "entityLanguages": ["en", "ja"],         // optional, BCP 47 codes (mempalace >= 3.3.2)
 *     "autoInstall": true,                      // optional, bootstrap venv + pip install on first run
 *     "verbose": false                          // optional, enables MEMPAL_VERBOSE diagnostics
 *   }
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import {
  MEMPALACE_INSTALL_TARGET,
  MEMPALACE_MIN_VERSION,
  detectMempalaceVersion,
  ensureMempalaceInstalled,
  isVersionSupported,
} from "./install.js";

export { MEMPALACE_INSTALL_TARGET, MEMPALACE_MIN_VERSION } from "./install.js";

const execFile = promisify(execFileCb);

/** Load from ~/.talon/prompts/ (user-customisable, seeded on first run) */
const PROMPT_PATH = resolve(dirs.prompts, "mempalace.md");

/**
 * Create a mempalace plugin instance with resolved paths.
 * Uses a factory because MCP server command/args depend on runtime config.
 */
export function createMempalacePlugin(config: {
  pythonPath: string;
  palacePath: string;
  /** BCP 47 codes passed via MEMPALACE_ENTITY_LANGUAGES (mempalace >= 3.3.2). */
  entityLanguages?: readonly string[];
  /** When true, sets MEMPAL_VERBOSE=1 so the MCP server logs diagnostic diaries. */
  verbose?: boolean;
  /**
   * When true, `init()` will create the venv / install / upgrade mempalace
   * to match {@link MEMPALACE_INSTALL_TARGET} if the current install is
   * missing or below {@link MEMPALACE_MIN_VERSION}. Default false — we do
   * not touch the user's environment without consent.
   */
  autoInstall?: boolean;
}): TalonPlugin {
  const { pythonPath, palacePath, entityLanguages, verbose, autoInstall } =
    config;

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
    version: "1.1.0",

    mcpServer: {
      command: pythonPath,
      args: ["-m", "mempalace.mcp_server", "--palace", palacePath],
    },

    validateConfig() {
      // When autoInstall is on we defer every check to init() — we can't
      // fail validation for "not installed" if the whole point of init()
      // is to install it. Config is only invalid when paths are malformed,
      // which zod handles upstream.
      if (autoInstall) return undefined;

      const errors: string[] = [];
      if (!existsSync(pythonPath)) {
        errors.push(
          `Python binary not found at ${pythonPath}. Create or select a Python environment, set "pythonPath" to that interpreter, then run: ${pythonPath} -m pip install 'mempalace==${MEMPALACE_INSTALL_TARGET}' — or set mempalace.autoInstall=true to do it automatically.`,
        );
        return errors;
      }
      return undefined;
    },

    async init() {
      // Ensure palace directory exists
      if (!existsSync(palacePath)) {
        mkdirSync(palacePath, { recursive: true });
        log("mempalace", `Created palace directory: ${palacePath}`);
      }

      // Onboarding check: install / upgrade (if autoInstall) + verify version.
      // In non-autoInstall mode this is purely diagnostic — if install is
      // missing or below the supported floor we log a clear error but
      // don't block startup, so the MCP server can surface its own errors
      // for transient issues (pip mirror down, etc).
      const status = await ensureMempalaceInstalled({
        pythonPath,
        autoInstall: autoInstall === true,
      });
      for (const step of status.steps) log("mempalace", step);
      if (!status.ok) {
        if (autoInstall) {
          logError(
            "mempalace",
            status.error ?? "mempalace ensureInstalled failed",
          );
        } else {
          // Fall back to a soft smoke test so a missing version string
          // doesn't spam errors on every startup — user opted out of auto.
          const detected = await detectMempalaceVersion(pythonPath, execFile);
          if (
            detected &&
            !isVersionSupported(detected, MEMPALACE_MIN_VERSION)
          ) {
            logWarn(
              "mempalace",
              `installed version ${detected} is below supported minimum ${MEMPALACE_MIN_VERSION}. Run: ${pythonPath} -m pip install --upgrade 'mempalace==${MEMPALACE_INSTALL_TARGET}'`,
            );
          } else if (!detected) {
            logWarn(
              "mempalace",
              `mempalace import check failed — MCP server will try to initialize lazily, but expect errors. Install manually: ${pythonPath} -m pip install 'mempalace==${MEMPALACE_INSTALL_TARGET}'`,
            );
          }
        }
      }

      const langSuffix =
        entityLanguages && entityLanguages.length > 0
          ? ` (languages: ${entityLanguages.join(",")})`
          : "";
      const versionSuffix = status.version
        ? ` [mempalace ${status.version}]`
        : "";
      log(
        "mempalace",
        `Ready (palace: ${palacePath})${langSuffix}${versionSuffix}`,
      );
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
          `Failed to load prompt from ${PROMPT_PATH}: ${err instanceof Error ? err.message : err}`,
        );
        return `## MemPalace — Long-term Memory\n\nPalace location: \`${palacePath}\`\nEntity languages: ${languagesLine}`;
      }
    },
  };
}
