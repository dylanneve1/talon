/**
 * Kilo one-shot agent runner — used by heartbeat & dream.
 *
 * The heartbeat/dream modules own timing, locking, and the run log file.
 * This module owns everything Kilo-specific: ensuring the Kilo HTTP server
 * is up, registering an MCP server tagged with the contextLabel (so the
 * agent's outbound tool calls reach the right frontend), creating an
 * ephemeral session, running the prompt, and cleaning up.
 *
 * Kilo runs in a long-lived process (the local HTTP server), so there are
 * no orphan subprocesses to evict — the corresponding `evictOrphanSubprocesses`
 * is intentionally not implemented.
 *
 * Note on abort semantics: the Kilo SDK does not surface a per-prompt
 * cancellation API, so once `oc.session.prompt()` is in flight the heartbeat
 * timeout's `abortController.abort()` is best-effort — we stop iterating but
 * the in-flight prompt continues until the underlying provider returns. The
 * heartbeat module's outer abort grace is what actually unblocks the lock.
 */

import type { OneShotAgentParams } from "../../core/types.js";
import { logWarn } from "../../util/log.js";
import {
  ensureServer,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  resolveProviderID,
  parseStoredOpenCodeModelSelection,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
} from "./server.js";

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

  const oc = await ensureServer();
  const { providerID: selectedProviderID, modelID } =
    parseStoredOpenCodeModelSelection(model);
  const providerID =
    selectedProviderID ?? (await resolveProviderID(oc, modelID));

  const chatMcpServerName = await ensureChatMcpServer(oc, contextLabel);
  await ensurePluginMcpServers(oc, contextLabel);
  const toolOverrides = await buildToolOverrides(oc, chatMcpServerName);

  const sessionResp = await oc.session.create({
    title: `One-shot ${contextLabel} ${new Date().toISOString()}`,
  });
  const sessionData = sessionResp.data as Record<string, unknown> | undefined;
  const sessionID =
    typeof sessionData?.id === "string" ? sessionData.id : String(Date.now());

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }

    const resp = await oc.session.prompt({
      sessionID,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: systemPrompt + OPENCODE_SYSTEM_PROMPT_SUFFIX,
      ...(toolOverrides ? { tools: toolOverrides } : {}),
    });

    const data = resp.data as Record<string, unknown> | undefined;
    const parts = Array.isArray(data?.parts)
      ? (data.parts as Array<Record<string, unknown>>)
      : [];

    for (const part of parts) {
      await appendKiloPart(appendLog, part);
    }
  } finally {
    await disconnectChatMcpServer(oc, chatMcpServerName);
    try {
      await oc.session.delete({ sessionID });
    } catch (err) {
      logWarn(
        "agent",
        `Failed to delete one-shot Kilo session ${sessionID}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function appendKiloPart(
  appendLog: (text: string) => Promise<void>,
  part: Record<string, unknown>,
): Promise<void> {
  const ts = new Date().toISOString().slice(11, 19);
  const type = typeof part.type === "string" ? part.type : "unknown";

  if (type === "text") {
    const text = typeof part.text === "string" ? part.text : "";
    if (text) await appendLog(`\n## [${ts}] Assistant\n${text}\n`);
    return;
  }

  if (type === "tool" || type === "tool_use") {
    const name =
      typeof part.tool === "string"
        ? part.tool
        : typeof part.name === "string"
          ? part.name
          : "tool";
    const input =
      "input" in part ? part.input : "state" in part ? part.state : null;
    await appendLog(
      `\n**Tool call:** \`${name}\`\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\`\n`,
    );
    return;
  }

  if (type === "step-start" || type === "step-finish") {
    return;
  }

  if (type === "reasoning") {
    const text = typeof part.text === "string" ? part.text : "";
    if (text) await appendLog(`\n### [${ts}] Reasoning\n${text}\n`);
    return;
  }

  // Fallback: dump unknown part types so we don't lose information.
  const truncated = JSON.stringify(part, null, 2).slice(0, 2000);
  await appendLog(
    `\n### [${ts}] Part (${type})\n\`\`\`json\n${truncated}\n\`\`\`\n`,
  );
}
