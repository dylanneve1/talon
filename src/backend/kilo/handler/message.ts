/**
 * Kilo main message handler — the shared remote-server chat turn bound to
 * Kilo's server bindings.
 */

import type { QueryParams, QueryResult } from "../../shared/handler-types.js";
import { runRemoteChatTurn } from "../../remote-server/chat-turn.js";
import {
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  resolveProviderID,
  parseStoredKiloModelSelection,
  getConfig,
  kiloSystemPromptSuffix,
} from "../server.js";

export function handleMessage(params: QueryParams): Promise<QueryResult> {
  // Assembled per call, not at module load: tests mock `../server.js`
  // with a partial surface and only touch the members they need.
  return runRemoteChatTurn(
    {
      id: "kilo",
      label: "Kilo",
      getConfig,
      ensureServer,
      parseModelSelection: parseStoredKiloModelSelection,
      resolveProviderID,
      ensureSession,
      ensureChatMcpServer,
      ensurePluginMcpServers,
      buildToolOverrides,
      systemPromptSuffix: kiloSystemPromptSuffix,
    },
    params,
  );
}
