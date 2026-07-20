/**
 * mem0 plugin — long-term memory via the mem0 platform (https://mem0.ai).
 *
 * Registers a stdio MCP server (server.ts) bridging the `mem0ai` SDK,
 * giving the agent semantic memory add/search/list/get/delete. Works
 * against the hosted platform (API key) or a self-hosted mem0 server
 * (host URL).
 *
 * Preferred configuration in ~/.talon/config.json:
 *   "memory": {
 *     "enabled": true,
 *     "backend": "mem0",
 *     "mem0": {
 *       "apiKey": "m0-...",              // default: MEM0_API_KEY env var
 *       "host": "http://localhost:8888", // optional self-hosted server
 *       "userId": "talon"                // optional entity id (default "talon")
 *     }
 *   }
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TalonPlugin } from "../../core/plugin/types.js";
import { log, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";

/** Load from ~/.talon/prompts/ (user-customisable, seeded on first run) */
const PROMPT_PATH = resolve(dirs.prompts, "mem0.md");

const SERVER_PATH = fileURLToPath(new URL("./server.ts", import.meta.url));

export function createMem0Plugin(config: {
  /** Platform API key. Falls back to the MEM0_API_KEY env var. */
  apiKey?: string;
  /** Self-hosted mem0 server URL; when set, apiKey may be omitted. */
  host?: string;
  /** Entity id memories are filed under (default "talon"). */
  userId?: string;
}): TalonPlugin {
  const apiKey = config.apiKey?.trim() || process.env.MEM0_API_KEY?.trim();
  const host = config.host?.trim();
  const userId = config.userId?.trim() || "talon";

  return {
    name: "mem0",
    description: "mem0 — long-term memory layer (hosted or self-hosted)",
    version: "1.0.0",

    mcpServerPath: SERVER_PATH,

    validateConfig() {
      if (!apiKey && !host) {
        return [
          'mem0 requires an API key ("memory.mem0.apiKey" or the MEM0_API_KEY env var) or a self-hosted "memory.mem0.host" URL.',
        ];
      }
      return undefined;
    },

    init() {
      log(
        "mem0",
        `Ready (${host ? `host: ${host}` : "hosted platform"}, user: ${userId})`,
      );
    },

    getEnvVars() {
      const env: Record<string, string> = { MEM0_USER_ID: userId };
      if (apiKey) env.MEM0_API_KEY = apiKey;
      if (host) env.MEM0_HOST = host;
      return env;
    },

    getSystemPromptAddition() {
      try {
        const template = readFileSync(PROMPT_PATH, "utf-8");
        return template.replace(/\{\{userId\}\}/g, userId);
      } catch (err) {
        logWarn(
          "mem0",
          `Failed to load prompt from ${PROMPT_PATH}: ${err instanceof Error ? err.message : err}`,
        );
        return `## mem0 — Long-term Memory\n\nMemory entity id: \`${userId}\``;
      }
    },
  };
}
