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

import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { TalonPlugin } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";

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
      } catch (err) {
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
      return `## MemPalace — Long-term Memory

You have access to a MemPalace for structured, searchable long-term memory. It stores verbatim text in a local ChromaDB vector database organized into wings (categories) and rooms (subcategories).

### Key tools:
- **mempalace_search** — Semantic search across all memories. Use wing/room filters to narrow results.
- **mempalace_add_drawer** — Store a new memory with wing + room classification.
- **mempalace_check_duplicate** — Check if content already exists before adding.
- **mempalace_status** — Overview of palace contents (wings, rooms, drawer counts).
- **mempalace_list_wings** / **mempalace_list_rooms** — Browse the palace structure.
- **mempalace_get_taxonomy** — Full wing → room → drawer count tree.
- **mempalace_kg_add** — Add a knowledge graph triple (subject → predicate → object) with temporal validity.
- **mempalace_kg_query** — Query the knowledge graph for entity relationships.
- **mempalace_kg_invalidate** — Mark a relationship as no longer valid.

### Wing structure for this bot:
- **users** — Per-user facts, preferences, and profiles (rooms: dylan, pawel, nick, narek, etc.)
- **projects** — Technical projects and repos (rooms: talon, mempalace, agin-music, tfi, etc.)
- **events** — Notable events, incidents, and milestones (rooms: general)
- **conversations** — Important conversation summaries and decisions (rooms: group, dm)
- **technical** — Technical knowledge, APIs, code patterns (rooms: general)

### When to use:
- **Search** when a user asks about something from past conversations or stored knowledge.
- **Add** important facts, decisions, preferences, and project details after learning them.
- **Knowledge graph** for structured relationships (e.g., "Dylan" → "created" → "Talon").
- You do NOT need to store everything — only store genuinely useful long-term information.
- Check for duplicates before adding to avoid clutter.

### Palace location: \`${palacePath}\``;
    },
  };
}
