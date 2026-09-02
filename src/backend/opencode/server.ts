/**
 * OpenCode server lifecycle — the OpenCode profile bound through
 * `backend/remote-server/server-bindings.ts`.
 *
 * The server spawn, MCP registration, session creation, and provider
 * resolution are the shared remote-server family implementation (Kilo is
 * a fork with the same HTTP API). This module holds only what is
 * OpenCode's: the SDK constructors, port 4096, the text-preferred
 * delivery contract, and the fuzzy `provider/model` parser. The exports
 * keep their historical names — the models module, one-shot runner,
 * tests, and `vi.mock("../backend/opencode/server.js")` all address them.
 */

import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import {
  normalizeModelLookup,
  parseRemoteModelQuery,
} from "../remote-server/model-catalog/index.js";
import {
  bindRemoteServer,
  type RemoteModelSelection,
} from "../remote-server/server-bindings.js";

/**
 * Parse the stored model-selection string into a `{providerID?, modelID}`
 * pair. The parser is fuzzy — it tries to extract a provider hint from the
 * prefix while preserving the full model id when ambiguous. See
 * `remote-server/model-catalog/` for the underlying `parseRemoteModelQuery`.
 */
export function parseStoredOpenCodeModelSelection(
  value: string,
): RemoteModelSelection {
  const { providerQuery, modelQuery } = parseRemoteModelQuery(value);
  return {
    providerID: providerQuery ? normalizeModelLookup(providerQuery) : undefined,
    modelID: modelQuery,
  };
}

// Text-preferred delivery: plain assistant text is the reply; tools only
// for genuine side effects. Single-sourced from the shared contract
// templates (prompts/system/contract-text-preferred.md).
const opencode = bindRemoteServer<OpencodeClient>({
  label: "OpenCode",
  defaultPort: 4096,
  portEnv: "OPENCODE_PORT",
  deliveryContract: "text-preferred",
  createClient: (baseUrl) =>
    createOpencodeClient({ baseUrl, throwOnError: true }),
  createServer: ({ hostname, port, timeout }) =>
    createOpencodeServer({ hostname, port, timeout }),
  parseModelSelection: parseStoredOpenCodeModelSelection,
});

export const OPENCODE_BASE_URL = opencode.baseUrl;
export const opencodeSystemPromptSuffix = opencode.systemPromptSuffix;
export const OPENCODE_SYSTEM_PROMPT_SUFFIX = opencode.defaultSystemPromptSuffix;
export const initOpenCodeAgent = opencode.init;
export const stopOpenCodeServer = opencode.stop;
export const {
  onServerStop,
  ensureServer,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  refreshPluginMcpServers,
  updateSystemPrompt,
  ensureSession,
  warmSession,
  resolveProviderID,
  getConfig,
  getRegisteredMcpServerNames,
  errMsg,
} = opencode;
