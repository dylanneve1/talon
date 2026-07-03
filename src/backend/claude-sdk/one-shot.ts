/**
 * Claude SDK one-shot agent runner — used by heartbeat & dream.
 *
 * The heartbeat/dream modules own timing, locking, state, and the run log
 * file. This module owns everything Claude-SDK-specific: building the SDK
 * options dict, calling `query()`, formatting each SDK message into the run
 * log, and post-abort orphan-subprocess eviction (Linux /proc walk).
 *
 * Exposed via the Backend abstraction (see core/types.ts) so that
 * non-SDK backends (Kilo, OpenCode) can supply their own implementations
 * without heartbeat/dream knowing the difference.
 */

import { readdir, readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OneShotAgentParams } from "../../core/types.js";
import { log } from "../../util/log.js";
import { ALLOWED_TOOLS_BACKGROUND } from "../../core/constants.js";
import { buildMcpServers, buildPluginMcpServers } from "./options.js";

const DEFAULT_SUBPROCESS_KILL_GRACE_MS = 5 * 1000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** SIGTERM → grace → SIGKILL window when force-killing orphan subprocesses. */
const SUBPROCESS_KILL_GRACE_MS = envMs(
  "TALON_HEARTBEAT_SUBPROCESS_KILL_GRACE_MS",
  DEFAULT_SUBPROCESS_KILL_GRACE_MS,
);

/**
 * Optional config the bootstrap layer passes in once at startup so
 * runOneShotAgent can locate the bundled `claude` binary and (for dream)
 * scope MCP servers to a specific plugin set.
 */
export type OneShotConfig = {
  claudeBinary?: string;
  /** MemPalace MCP config gate — only relevant for the dream context. */
  mempalace?: { pythonPath: string; palacePath: string };
};

let oneShotConfig: OneShotConfig = {};

export function initClaudeOneShot(cfg: OneShotConfig): void {
  oneShotConfig = cfg;
}

export async function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<void> {
  const {
    prompt,
    systemPrompt,
    workspace,
    model,
    contextLabel,
    abortController,
    appendLog,
  } = params;

  const options = {
    model,
    systemPrompt,
    cwd: workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    abortController,
    ...(oneShotConfig.claudeBinary
      ? { pathToClaudeCodeExecutable: oneShotConfig.claudeBinary }
      : {}),
    mcpServers: assembleMcpServers(contextLabel),
    // Whitelist of SDK built-in tools for background contexts (heartbeat,
    // dream). Same as chat minus `Agent` — nested sub-agent dispatch from
    // inside an unattended pass complicates lifecycle tracking.
    tools: [...ALLOWED_TOOLS_BACKGROUND],
  };

  const qi = query({
    prompt,
    options: options as Parameters<typeof query>[0]["options"],
  });

  for await (const msg of qi) {
    await formatAndAppendMessage(appendLog, msg);
  }
}

/**
 * Per-context MCP server selection.
 * - "heartbeat": frontend tools + all loaded plugins (full surface so the
 *   heartbeat agent can post messages, react, read history, etc.).
 * - "dream": only mempalace (when configured) — dream is a memory
 *   consolidation pass and shouldn't be doing outbound messaging.
 * - anything else: empty (treat unknown contexts as plugin-free).
 *
 * `buildMcpServers` throws if the agent config hasn't been initialised
 * (e.g. unit tests that mock the agent). Treat that case as "no frontend
 * MCP available" rather than crashing the whole one-shot run — plugin MCP
 * servers still load and the agent runs normally.
 */
function assembleMcpServers(contextLabel: string): Record<string, unknown> {
  if (contextLabel === "heartbeat") {
    let frontendServers: Record<string, unknown> = {};
    try {
      frontendServers = buildMcpServers("heartbeat") as Record<string, unknown>;
    } catch {
      frontendServers = {};
    }
    let pluginServers: Record<string, unknown> = {};
    try {
      pluginServers = buildPluginMcpServers("heartbeat");
    } catch {
      pluginServers = {};
    }
    return { ...frontendServers, ...pluginServers };
  }
  if (contextLabel === "dream") {
    if (!oneShotConfig.mempalace) return {};
    try {
      return buildPluginMcpServers("dream", ["mempalace"]);
    } catch {
      return {};
    }
  }
  return {};
}

async function formatAndAppendMessage(
  appendLog: (text: string) => Promise<void>,
  msg: SDKMessage,
): Promise<void> {
  try {
    const ts = new Date().toISOString().slice(11, 19);

    switch (msg.type) {
      case "assistant": {
        const textBlocks = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => ("text" in b ? (b as { text: string }).text : ""));
        const toolUseBlocks = msg.message.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const tu = b as { name: string; input: unknown };
            return `**Tool call:** \`${tu.name}\`\n\`\`\`json\n${JSON.stringify(tu.input, null, 2)}\n\`\`\``;
          });

        if (textBlocks.length > 0) {
          await appendLog(`\n## [${ts}] Assistant\n${textBlocks.join("\n")}\n`);
        }
        if (toolUseBlocks.length > 0) {
          await appendLog(`\n${toolUseBlocks.join("\n\n")}\n`);
        }
        break;
      }
      case "result": {
        const result =
          "result" in msg
            ? (msg as { result: string }).result
            : JSON.stringify(msg);
        const truncated =
          result.length > 2000
            ? result.slice(0, 2000) + "\n... (truncated)"
            : result;
        await appendLog(
          `\n### [${ts}] Result (${msg.subtype})\n\`\`\`\n${truncated}\n\`\`\`\n`,
        );
        break;
      }
      case "system": {
        await appendLog(`\n### [${ts}] System (${msg.subtype})\n`);
        break;
      }
      case "user": {
        if (msg.tool_use_result != null) {
          const raw =
            typeof msg.tool_use_result === "string"
              ? msg.tool_use_result
              : JSON.stringify(msg.tool_use_result, null, 2);
          const truncated =
            raw.length > 2000 ? raw.slice(0, 2000) + "\n... (truncated)" : raw;
          await appendLog(
            `\n### [${ts}] Tool Result\n\`\`\`\n${truncated}\n\`\`\`\n`,
          );
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    process.stderr.write(
      `[one-shot] Log write error: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

/**
 * Find and kill any lingering `claude` subprocess (and its descendants) whose
 * environment carries `TALON_CHAT_ID=<contextLabel>`. We identify them by
 * reading /proc/<pid>/environ — that file is owned by the same uid as the
 * spawner (us) and contains the env vars Talon set when launching the SDK
 * subprocess via MCP launcher. SIGTERM with a short grace, then SIGKILL.
 */
export async function evictOrphanSubprocesses(contextLabel: string): Promise<{
  found: number;
  termed: number;
  killed: number;
}> {
  const result = { found: 0, termed: 0, killed: 0 };

  if (process.platform !== "linux") {
    // /proc is Linux-only. macOS/Windows: rely on SDK abort + grace alone.
    return result;
  }

  const myPid = process.pid;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return result;
  }

  const target = `TALON_CHAT_ID=${contextLabel}`;
  const matched: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === myPid) continue;
    try {
      const environRaw = await readFile(`/proc/${pid}/environ`, "utf-8");
      // /proc/<pid>/environ is NUL-delimited. Split on \0 and match exact
      // entries — a raw .includes() can false-positive on other vars whose
      // value happens to contain the substring. Since this code can SIGKILL,
      // err on the side of strict matching. (Copilot review on #144.)
      const envEntries = environRaw.split("\0");
      if (envEntries.includes(target)) {
        matched.push(pid);
      }
    } catch {
      // Process exited between readdir and readFile, or we don't own it. Skip.
      continue;
    }
  }

  result.found = matched.length;
  if (matched.length === 0) return result;

  for (const pid of matched) {
    try {
      process.kill(pid, "SIGTERM");
      result.termed++;
    } catch {
      // ESRCH (already gone) or EPERM — ignore.
    }
  }

  await new Promise<void>((r) => {
    const t = setTimeout(r, SUBPROCESS_KILL_GRACE_MS);
    t.unref();
  });

  for (const pid of matched) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
      result.killed++;
    } catch {
      // Already gone — no-op.
    }
  }

  log(
    "heartbeat",
    `Subprocess sweep (${contextLabel}): found=${result.found} termed=${result.termed} killed=${result.killed}`,
  );
  return result;
}
