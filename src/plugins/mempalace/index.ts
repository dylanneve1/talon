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
import { resolve } from "node:path";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";

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
        return errors;
      }

      // Verify mempalace.mcp_server is importable (the actual module spawned by MCP)
      try {
        execFileSync(pythonPath, ["-c", "import mempalace.mcp_server"], {
          timeout: 15_000,
          stdio: "pipe",
        });
      } catch (err: unknown) {
        const execErr =
          err && typeof err === "object"
            ? (err as {
                code?: string;
                signal?: string;
                killed?: boolean;
                stderr?: string | Buffer;
              })
            : undefined;
        const code = execErr?.code;
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
          errors.push(
            `Cannot execute Python at ${pythonPath} (${code}). Check that the path is correct and the binary is executable.`,
          );
        } else if (code === "ETIMEDOUT" || execErr?.killed || execErr?.signal) {
          errors.push(
            `Python import check timed out or was killed. The interpreter at ${pythonPath} may be unresponsive.`,
          );
        } else {
          const stderr =
            typeof execErr?.stderr === "string"
              ? execErr.stderr.trim()
              : Buffer.isBuffer(execErr?.stderr)
                ? execErr.stderr.toString("utf-8").trim()
                : "";
          errors.push(
            `mempalace package not installed or mcp_server submodule missing. Run: ${pythonPath} -m pip install mempalace${stderr ? `. Details: ${stderr}` : ""}`,
          );
        }
      }

      return errors.length > 0 ? errors : undefined;
    },

    async init() {
      // Ensure palace directory exists
      if (!existsSync(palacePath)) {
        mkdirSync(palacePath, { recursive: true });
        log("mempalace", `Created palace directory: ${palacePath}`);
      }

      // Quick smoke test — verify mempalace can import and access the palace path
      try {
        const { stdout } = await execFile(
          pythonPath,
          [
            "-c",
            `import mempalace; print(f"mempalace {mempalace.__version__}" if hasattr(mempalace, "__version__") else "mempalace ok")`,
          ],
          { timeout: 15_000 },
        );
        log("mempalace", stdout.trim() || "Module verified");
      } catch {
        // Non-fatal — MCP server handles lazy init
        log(
          "mempalace",
          "Module import check skipped — MCP server will initialize on first use",
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
