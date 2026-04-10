/**
 * Web tools — search and URL fetching.
 *
 * These are platform-agnostic and available on all frontends.
 * Claude Code's built-in WebSearch / WebFetch are disabled in favour
 * of these MCP tools (which use Brave Search with SearXNG fallback).
 * These can be excluded via composeTools({ excludeTags: ["web"] }).
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const webTools: ToolDefinition[] = [
  {
    name: "web_search",
    description:
      "Search the web using Brave Search (with SearXNG fallback). Returns titles, URLs, and snippets. Use for current events, facts, or finding URLs to fetch.",
    schema: {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default 5, max 10)"),
    },
    execute: (params, bridge) => bridge("web_search", params),
    tag: "web",
  },

  {
    name: "fetch_url",
    description:
      "Fetch a URL — web pages return text content, image URLs are downloaded to workspace. Use to read articles, download images, or fetch any URL.",
    schema: {
      url: z.string().describe("The URL to fetch"),
    },
    execute: (params, bridge) => bridge("fetch_url", params),
    tag: "web",
  },
];
