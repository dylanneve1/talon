/**
 * OpenCode one-shot agent runner — used by heartbeat & dream.
 *
 * Thin binding over the shared remote-server runner (see
 * `backend/remote-server/one-shot.ts` for the design notes): OpenCode
 * supplies its server bootstrap, model-selection parser, and delivery
 * suffix; everything else is the shared lifecycle.
 */

import type { OneShotAgentParams, OneShotUsage } from "../../core/types.js";
import { runRemoteOneShotAgent } from "../remote-server/one-shot.js";
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

export function runOneShotAgent(
  params: OneShotAgentParams,
): Promise<OneShotUsage | void> {
  return runRemoteOneShotAgent(
    {
      label: "OpenCode",
      systemPromptSuffix: OPENCODE_SYSTEM_PROMPT_SUFFIX,
      ensureServer,
      parseModelSelection: parseStoredOpenCodeModelSelection,
      resolveProviderID,
      ensureChatMcpServer,
      ensurePluginMcpServers,
      buildToolOverrides,
      disconnectChatMcpServer,
      errMsg,
    },
    params,
  );
}
