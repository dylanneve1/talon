/**
 * OpenCode one-shot agent runner — used by heartbeat & dream.
 *
 * Mirrors src/backend/kilo/one-shot.ts (Kilo is a fork of OpenCode and the
 * SDK shape is the same). See that file's header for the design notes.
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
      await appendOpenCodePart(appendLog, part);
    }
  } finally {
    await disconnectChatMcpServer(oc, chatMcpServerName);
    try {
      await oc.session.delete({ sessionID });
    } catch (err) {
      logWarn(
        "agent",
        `Failed to delete one-shot OpenCode session ${sessionID}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function appendOpenCodePart(
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

  const truncated = JSON.stringify(part, null, 2).slice(0, 2000);
  await appendLog(
    `\n### [${ts}] Part (${type})\n\`\`\`json\n${truncated}\n\`\`\`\n`,
  );
}
