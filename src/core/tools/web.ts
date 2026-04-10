/**
 * Web tools — URL fetching.
 *
 * Platform-agnostic, available on all frontends.
 * Web search is handled by the Brave Search MCP server (registered in
 * claude-sdk/index.ts) when configured. URL fetching is provided here via
 * the `fetch_url` tool, so Claude Code's built-in WebSearch / WebFetch are
 * disabled in favor of these project-specific replacements.
 * These can be excluded via composeTools({ excludeTags: ["web"] }).
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const webTools: ToolDefinition[] = [
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
