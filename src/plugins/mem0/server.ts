/**
 * mem0 MCP server — stdio subprocess spawned by the plugin loader.
 *
 * Thin bridge over the `mem0ai` MemoryClient (hosted platform or a
 * self-hosted server via MEM0_HOST). All memories are scoped to one
 * entity (MEM0_USER_ID) so the palace of a single Talon deployment
 * stays isolated inside a shared mem0 project.
 *
 * Env contract (set by src/plugins/mem0/index.ts getEnvVars):
 *   MEM0_API_KEY   — platform API key (required unless MEM0_HOST is set)
 *   MEM0_HOST      — optional self-hosted API base URL
 *   MEM0_USER_ID   — entity id memories are filed under (default "talon")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import MemoryClient from "mem0ai";

const apiKey = process.env.MEM0_API_KEY ?? "";
const host = process.env.MEM0_HOST;
const userId = process.env.MEM0_USER_ID || "talon";

const client = new MemoryClient({ apiKey, ...(host ? { host } : {}) });

/** v3 search/list scope every call to this deployment's entity. */
const entityFilter = { AND: [{ user_id: userId }] };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

function errorResult(err: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `mem0 error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

const server = new McpServer({ name: "mem0-tools", version: "1.0.0" });

server.tool(
  "mem0_add_memory",
  "Store new information in mem0 long-term memory. Pass conversational text; mem0 extracts and files the durable facts itself.",
  {
    text: z.string().min(1).describe("The information to remember"),
    role: z
      .enum(["user", "assistant"])
      .optional()
      .describe("Who the information came from (default user)"),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe("Optional key/value tags stored with the memory"),
  },
  async ({ text, role, metadata }) => {
    try {
      const memories = await client.add(
        [{ role: role ?? "user", content: text }],
        {
          userId,
          ...(metadata ? { metadata } : {}),
        },
      );
      return textResult({ stored: memories.length, memories });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "mem0_search_memory",
  "Semantic search over mem0 memories. Use short keyword queries, not full sentences.",
  {
    query: z.string().min(1).describe("Search query"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max results (default 10)"),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum relevance score, 0-1"),
  },
  async ({ query, limit, threshold }) => {
    try {
      const { results } = await client.search(query, {
        filters: entityFilter,
        topK: limit ?? 10,
        ...(threshold !== undefined ? { threshold } : {}),
      });
      return textResult({ count: results.length, results });
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "mem0_list_memories",
  "Browse stored mem0 memories with pagination. Use for inventory/cleanup, not search.",
  {
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number (default 1)"),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results per page (default 25)"),
  },
  async ({ page, page_size }) => {
    try {
      const result = await client.getAll({
        filters: entityFilter,
        page: page ?? 1,
        pageSize: page_size ?? 25,
      });
      return textResult(result);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "mem0_get_memory",
  "Fetch a single mem0 memory by id, with full content and metadata.",
  { memory_id: z.string().min(1).describe("Memory id from search/list") },
  async ({ memory_id }) => {
    try {
      return textResult(await client.get(memory_id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.tool(
  "mem0_delete_memory",
  "Delete a mem0 memory by id when it is wrong or stale.",
  { memory_id: z.string().min(1).describe("Memory id from search/list") },
  async ({ memory_id }) => {
    try {
      return textResult(await client.delete(memory_id));
    } catch (err) {
      return errorResult(err);
    }
  },
);

await server.connect(new StdioServerTransport());
