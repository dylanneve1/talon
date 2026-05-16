/**
 * Codex one-shot agent runner — used by heartbeat & dream.
 *
 * The heartbeat/dream modules own timing, locking, and the run log
 * file. This module owns everything Codex-specific:
 *
 *   - Ensuring the per-context Codex instance is built (with the
 *     contextLabel's MCP servers wired in).
 *   - Starting an ephemeral thread (heartbeat / dream don't resume —
 *     each run is fresh).
 *   - Streaming `runStreamed` events into the run log.
 *   - Honouring the heartbeat module's abort controller so timeouts
 *     stop the model promptly.
 *
 * Codex spawns the `codex` CLI as a subprocess per `runStreamed` call.
 * The SDK's AbortSignal cuts the subprocess cleanly when the abort
 * fires — no orphan process handling needed.
 */

import type { OneShotAgentParams } from "../../core/types.js";
import { logWarn } from "../../util/log.js";
import { appendBackendSuffix } from "../shared/index.js";
import { ensureCodex } from "./init.js";
import { CODEX_SYSTEM_PROMPT_SUFFIX } from "./constants.js";

export async function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<void> {
  const {
    prompt,
    systemPrompt,
    model,
    contextLabel,
    abortController,
    appendLog,
  } = params;

  const codex = ensureCodex(contextLabel);

  const finalSystemPrompt = appendBackendSuffix(
    systemPrompt,
    CODEX_SYSTEM_PROMPT_SUFFIX,
  );

  // Codex SDK doesn't expose `system` on runStreamed — the system
  // prompt gets prepended to the user prompt for a one-shot, since
  // there's no thread continuity to worry about.
  const inputText = `${finalSystemPrompt}\n\n---\n\n${prompt}`;

  const thread = codex.startThread({
    model,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
  });

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }

    const { events } = await thread.runStreamed(inputText, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      if (abortController.signal.aborted) break;
      await appendCodexEvent(appendLog, event);
    }
  } catch (err) {
    if (
      abortController.signal.aborted ||
      /abort/i.test(err instanceof Error ? err.message : String(err))
    ) {
      const ts = new Date().toISOString().slice(11, 19);
      await appendLog(`\n### [${ts}] Aborted\nRun aborted by timeout.\n`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logWarn("agent", `Codex one-shot run failed: ${msg}`);
    const ts = new Date().toISOString().slice(11, 19);
    await appendLog(`\n### [${ts}] Error\n${msg}\n`);
  }
}

/**
 * Append one Codex `ThreadEvent` to the run log. We surface:
 *
 *   - `thread.started` — record the thread id for diagnostic purposes.
 *   - `turn.started` / `turn.completed` — markers around the model's work.
 *   - `item.completed` — the meat: agent messages, tool calls, reasoning,
 *     command execution, file changes, web searches, todo lists, errors.
 *   - `turn.failed` / `error` — surface upstream failures into the log.
 *
 * `item.started` / `item.updated` are skipped to keep the log readable —
 * the completed snapshot of each item is sufficient.
 */
async function appendCodexEvent(
  appendLog: (text: string) => Promise<void>,
  event: { type: string } & Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString().slice(11, 19);

  switch (event.type) {
    case "thread.started": {
      const id =
        typeof event.thread_id === "string" ? event.thread_id : "(unknown)";
      await appendLog(`\n### [${ts}] Thread started\n\`${id}\`\n`);
      return;
    }
    case "turn.started":
      await appendLog(`\n### [${ts}] Turn started\n`);
      return;
    case "turn.completed": {
      const usage = (event as { usage?: Record<string, number> }).usage;
      if (usage) {
        await appendLog(
          `\n### [${ts}] Turn completed\ninput=${usage.input_tokens ?? 0} ` +
            `cached=${usage.cached_input_tokens ?? 0} ` +
            `output=${usage.output_tokens ?? 0} ` +
            `reasoning=${usage.reasoning_output_tokens ?? 0}\n`,
        );
      } else {
        await appendLog(`\n### [${ts}] Turn completed\n`);
      }
      return;
    }
    case "turn.failed": {
      const err = (event as { error?: { message?: string } }).error;
      await appendLog(
        `\n### [${ts}] Turn FAILED\n${err?.message ?? "(no message)"}\n`,
      );
      return;
    }
    case "error": {
      const msg =
        typeof event.message === "string" ? event.message : "(no message)";
      await appendLog(`\n### [${ts}] ERROR\n${msg}\n`);
      return;
    }
    case "item.completed": {
      const item = (event as unknown as { item?: Record<string, unknown> })
        .item;
      if (item) await appendCodexItem(appendLog, item, ts);
      return;
    }
    default:
      return;
  }
}

/** Append one `ThreadItem` to the run log. */
async function appendCodexItem(
  appendLog: (text: string) => Promise<void>,
  item: Record<string, unknown>,
  ts: string,
): Promise<void> {
  const type = typeof item.type === "string" ? item.type : "unknown";

  if (type === "agent_message") {
    const text = typeof item.text === "string" ? item.text : "";
    if (text) await appendLog(`\n## [${ts}] Assistant\n${text}\n`);
    return;
  }

  if (type === "reasoning") {
    const text = typeof item.text === "string" ? item.text : "";
    if (text) await appendLog(`\n### [${ts}] Reasoning\n${text}\n`);
    return;
  }

  if (type === "mcp_tool_call") {
    const server = typeof item.server === "string" ? item.server : "(unknown)";
    const tool = typeof item.tool === "string" ? item.tool : "(unknown)";
    const input = item.arguments ?? null;
    await appendLog(
      `\n**MCP tool call:** \`${server}.${tool}\`\n\`\`\`json\n${JSON.stringify(
        input,
        null,
        2,
      ).slice(0, 2000)}\n\`\`\`\n`,
    );
    return;
  }

  if (type === "command_execution") {
    const cmd = typeof item.command === "string" ? item.command : "(unknown)";
    const status = typeof item.status === "string" ? item.status : "(unknown)";
    const exitCode = item.exit_code;
    const exitTail = typeof exitCode === "number" ? ` exit=${exitCode}` : "";
    await appendLog(`\n**Command:** \`${cmd}\` (${status}${exitTail})\n`);
    return;
  }

  if (type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const status = typeof item.status === "string" ? item.status : "(unknown)";
    const list = changes
      .map((c) => {
        const change = c as { kind?: string; path?: string };
        return `  - ${change.kind ?? "?"} ${change.path ?? "?"}`;
      })
      .join("\n");
    await appendLog(`\n**File changes:** (${status})\n${list}\n`);
    return;
  }

  if (type === "web_search") {
    const query = typeof item.query === "string" ? item.query : "(unknown)";
    await appendLog(`\n**Web search:** \`${query}\`\n`);
    return;
  }

  if (type === "todo_list") {
    const items = Array.isArray(item.items) ? item.items : [];
    const list = items
      .map((todo) => {
        const t = todo as { text?: string; completed?: boolean };
        return `  - [${t.completed ? "x" : " "}] ${t.text ?? "?"}`;
      })
      .join("\n");
    await appendLog(`\n**Todo list:**\n${list}\n`);
    return;
  }

  if (type === "error") {
    const msg =
      typeof item.message === "string" ? item.message : "(no message)";
    await appendLog(`\n### [${ts}] Error item\n${msg}\n`);
    return;
  }

  // Fallback: dump unknown item types.
  const truncated = JSON.stringify(item, null, 2).slice(0, 2000);
  await appendLog(
    `\n### [${ts}] Item (${type})\n\`\`\`json\n${truncated}\n\`\`\`\n`,
  );
}
