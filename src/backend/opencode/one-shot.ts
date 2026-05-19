/**
 * OpenCode one-shot agent runner — used by heartbeat & dream.
 *
 * Mirrors src/backend/kilo/one-shot.ts (Kilo is a fork of OpenCode and the
 * SDK shape is the same). See that file's header for the design notes.
 *
 * Note on abort semantics: the OpenCode SDK exposes `session.abort` but the
 * REST `prompt` endpoint blocks until the underlying provider returns. The
 * heartbeat module's outer abort grace is what actually unblocks the lock
 * — we call `session.abort` as a best-effort cleanup so the model stops
 * spending tokens once the timeout fires.
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
  errMsg,
} from "./server.js";
import { appendBackendSuffix } from "../shared/index.js";

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

  // Abort handler: when the heartbeat timeout fires, ask OpenCode to stop
  // generating. The await on `session.prompt` will reject; we propagate.
  // Without this, runaway generation on a hung heartbeat keeps spending
  // tokens until the provider returns naturally — kilo/one-shot.ts has the
  // same handler and this file got out of sync with it.
  const onAbort = (): void => {
    oc.session
      .abort({ sessionID })
      .catch((err) =>
        logWarn(
          "agent",
          `One-shot session.abort failed for ${sessionID}: ${errMsg(err)}`,
        ),
      );
  };
  abortController.signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (abortController.signal.aborted) {
      throw new Error("Aborted before prompt was sent");
    }

    const finalSystemPrompt = appendBackendSuffix(
      systemPrompt,
      OPENCODE_SYSTEM_PROMPT_SUFFIX,
    );

    const resp = await oc.session.prompt({
      sessionID,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: finalSystemPrompt,
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
    abortController.signal.removeEventListener("abort", onAbort);
    await disconnectChatMcpServer(oc, chatMcpServerName);
    try {
      await oc.session.delete({ sessionID });
    } catch (err) {
      logWarn(
        "agent",
        `Failed to delete one-shot OpenCode session ${sessionID}: ${errMsg(err)}`,
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
