/**
 * MemPalace plugin — structured long-term memory with vector search.
 *
 * Registers the mempalace Python MCP server, giving the agent access to
 * semantic memory search, knowledge graph operations, and diary entries.
 *
 * Configuration in ~/.talon/config.json:
 *   "mempalace": {
 *     "enabled": true,
 *     "palacePath": "/path/to/palace",   // optional, defaults to ~/.talon/workspace/palace/
 *     "pythonPath": "/path/to/python"     // optional, defaults to ~/.talon/mempalace-venv/bin/python
 *   }
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, "../../../prompts/mempalace.md");

/**
 * Create a mempalace plugin instance with resolved paths.
 * Uses a factory because MCP server command/args depend on runtime config.
 */
export function createMempalacePlugin(config: {
  pythonPath: string;
  palacePath: string;
}): TalonPlugin {
  const { pythonPath, palacePath } = config;

  return {
    name: "mempalace",
    description:
      "Memory palace — structured long-term memory with vector search",
    version: "1.0.0",

    mcpServer: {
      command: pythonPath,
      args: ["-m", "mempalace.mcp_server", "--palace", palacePath],
    },

    validateConfig() {
      const errors: string[] = [];
      if (!existsSync(pythonPath)) {
        errors.push(
          `Python binary not found at ${pythonPath}. Create or select a Python environment, set "pythonPath" to that interpreter, then run: ${pythonPath} -m pip install mempalace`,
        );
      }
      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      // Ensure palace directory exists
      if (!existsSync(palacePath)) {
        mkdirSync(palacePath, { recursive: true });
        log("mempalace", `Created palace directory: ${palacePath}`);
      }

      // Verify mempalace is importable
      try {
        execFileSync(pythonPath, ["-c", "import mempalace"], {
          timeout: 15_000,
          stdio: "pipe",
        });
      } catch {
        logError(
          "mempalace",
          `mempalace not installed in ${pythonPath}. Run: ${pythonPath} -m pip install mempalace`,
        );
        return;
      }

      // Check palace status
      try {
        const status = execFileSync(
          pythonPath,
          ["-m", "mempalace", "status", "--palace", palacePath],
          { timeout: 30_000, stdio: "pipe", encoding: "utf-8" },
        );
        log(
          "mempalace",
          `Palace initialized: ${status.trim().split("\n")[0] || "ok"}`,
        );
      } catch {
        // Palace may not be initialized yet — that's fine, MCP server handles lazy init
        logWarn(
          "mempalace",
          "Palace not yet initialized — will be created on first use",
        );
      }

      log("mempalace", `Ready (palace: ${palacePath})`);
    },

    getEnvVars() {
      return {
        MEMPALACE_PALACE_PATH: palacePath,
      };
    },

    getSystemPromptAddition() {
      try {
        const template = readFileSync(PROMPT_PATH, "utf-8");
        return template.replace(/\{\{palacePath\}\}/g, palacePath);
      } catch (err) {
        logWarn(
          "mempalace",
          `Failed to load prompt from ${PROMPT_PATH}: ${err instanceof Error ? err.message : err}`,
        );
        return `## MemPalace — Long-term Memory\n\nPalace location: \`${palacePath}\``;
      }
    },
  };
}
