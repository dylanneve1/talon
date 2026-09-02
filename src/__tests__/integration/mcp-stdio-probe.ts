/**
 * Real stdio MCP session against a plugin's server, using the same
 * @modelcontextprotocol/sdk client the backends speak. Spawns exactly
 * what the plugin declares (`mcpServer.command/args` + `getEnvVars()`),
 * so a test here proves the runtime a provisioner installed answers the
 * protocol the way Talon will actually drive it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { TalonPlugin } from "../../core/plugin/types.js";

export interface McpProbeSession {
  client: Client;
  /** Tool names the server advertised. */
  tools: string[];
  /** Call a tool and return its concatenated text content. */
  callText(name: string, args: Record<string, unknown>): Promise<string>;
  /** Server stderr so far — for failure messages. */
  stderr(): string;
}

/**
 * Open a session against `plugin.mcpServer`, run `fn`, always tear down.
 * `extraEnv` layers over the plugin's own env (e.g. an isolated browser
 * cache or a CI token).
 */
export async function withPluginMcp<T>(
  plugin: TalonPlugin,
  fn: (session: McpProbeSession) => Promise<T>,
  opts: { extraEnv?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const server = plugin.mcpServer;
  if (!server) throw new Error(`${plugin.name} declares no mcpServer`);
  const env: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ) as Record<string, string>),
    ...plugin.getEnvVars?.({}),
    ...opts.extraEnv,
  };
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "talon-provision-ci", version: "0" });
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const withTimeout = <U>(p: Promise<U>, what: string): Promise<U> =>
    new Promise<U>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(
        () =>
          rejectPromise(
            new Error(
              `${plugin.name}: ${what} timed out after ${timeoutMs}ms\n--- server stderr ---\n${stderr}`,
            ),
          ),
        timeoutMs,
      );
      p.then(
        (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          rejectPromise(
            new Error(
              `${plugin.name}: ${what} failed: ${err instanceof Error ? err.message : String(err)}\n--- server stderr ---\n${stderr}`,
            ),
          );
        },
      );
    });

  try {
    await withTimeout(client.connect(transport), "initialize");
    const listed = await withTimeout(client.listTools(), "tools/list");
    const session: McpProbeSession = {
      client,
      tools: listed.tools.map((t) => t.name),
      stderr: () => stderr,
      callText: async (name, args) => {
        const result = await withTimeout(
          client.callTool({ name, arguments: args }, undefined, {
            timeout: timeoutMs,
          }),
          `tools/call ${name}`,
        );
        const content = (result as { content?: unknown }).content;
        const text = Array.isArray(content)
          ? content
              .map(
                (c: {
                  type?: string;
                  text?: string;
                  resource?: { text?: string };
                }) =>
                  c.type === "text"
                    ? (c.text ?? "")
                    : c.type === "resource"
                      ? (c.resource?.text ?? "")
                      : "",
              )
              .join("\n")
          : "";
        if ((result as { isError?: boolean }).isError) {
          throw new Error(
            `${plugin.name}: ${name} returned isError\n${text}\n--- server stderr ---\n${stderr}`,
          );
        }
        return text;
      },
    };
    return await fn(session);
  } finally {
    await client.close().catch(() => {});
  }
}
