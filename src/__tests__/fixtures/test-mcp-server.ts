/**
 * Minimal MCP server fixture for lifecycle integration tests.
 *
 * Uses the same McpServer + StdioServerTransport + stdin-close pattern
 * as the real src/core/tools/mcp-server.ts, but without Talon tool
 * composition so it starts fast and has no external dependencies.
 *
 * Signals readiness by writing "READY\n" to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "test-mcp", version: "1.0.0" });

// Register a trivial tool so the server has something to serve
server.tool("ping", "health check", {}, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Same graceful self-termination as the real mcp-server.ts
  process.stdin.on("end", () => {
    server.close().finally(() => process.exit(0));
  });

  // Signal readiness to the test harness
  process.stderr.write("READY\n");
}

main().catch((err) => {
  process.stderr.write(`test-mcp-server error: ${err}\n`);
  process.exit(1);
});
