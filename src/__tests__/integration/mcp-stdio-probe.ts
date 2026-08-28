/**
 * Real stdio MCP session against a plugin's server, using the same
 * @modelcontextprotocol/sdk client the backends speak. Spawns exactly
 * what the plugin declares (`mcpServer.command/args` + `getEnvVars()`),
 * so a test here proves the runtime a provisioner installed answers the
 * protocol the way Talon will actually drive it.
 *
 * With `supervise`, the server runs under Talon's own `_mcp-launch`
 * supervisor (util/mcp-launcher.ts), re-invoked from this repo's
 * src/cli.ts on the current runtime — bun natively, node via tsx —
 * exactly the chain a source run produces. That is what makes the same
 * test meaningful under both runtimes: the supervisor is the part that
 * differs.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TalonPlugin } from "../../core/plugin/types.js";
import { SUPERVISOR_CMD_ENV, wrapMcpServer } from "../../util/mcp-launcher.js";
import { isBunRuntime } from "../../util/runtime.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Runtime label for assertions that a CI job ran on what it claims. */
export function currentRuntime(): "bun" | "node" {
  return isBunRuntime() ? "bun" : "node";
}

/**
 * How to re-invoke this repo's Talon CLI on the current runtime, as the
 * `TALON_MCP_SUPERVISOR_CMD` override expects it: `[command, ...args]`
 * with the subcommand appended by the launcher. Under a test runner
 * `process.argv[1]` is the runner, not Talon, so the launcher's default
 * self-invocation cannot be used here.
 */
export function talonSelfInvocation(): string[] {
  const cli = resolve(REPO_ROOT, "src/cli.ts");
  if (isBunRuntime()) return [process.execPath, cli];
  return [
    process.execPath,
    "--import",
    resolve(REPO_ROOT, "node_modules/tsx/dist/esm/index.mjs"),
    cli,
  ];
}

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
  opts: {
    extraEnv?: Record<string, string>;
    timeoutMs?: number;
    /** Run under Talon's `_mcp-launch` supervisor on the current runtime. */
    supervise?: boolean;
  } = {},
): Promise<T> {
  const declared = plugin.mcpServer;
  if (!declared) throw new Error(`${plugin.name} declares no mcpServer`);
  const server = opts.supervise
    ? withSupervisorOverride(() =>
        wrapMcpServer({ command: declared.command, args: [...declared.args] }),
      )
    : { command: declared.command, args: [...declared.args] };
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

/** Run `fn` with the launcher's self-invocation pointed at this repo's CLI. */
function withSupervisorOverride<T>(fn: () => T): T {
  const previous = process.env[SUPERVISOR_CMD_ENV];
  process.env[SUPERVISOR_CMD_ENV] = JSON.stringify(talonSelfInvocation());
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[SUPERVISOR_CMD_ENV];
    else process.env[SUPERVISOR_CMD_ENV] = previous;
  }
}
