/**
 * Kilo server lifecycle — the Kilo profile bound through
 * `backend/remote-server/server-bindings.ts`.
 *
 * Kilo is a fork of OpenCode with the same HTTP API, so the server spawn,
 * MCP registration, session creation, and provider resolution are the
 * shared family implementation. This module holds only what is Kilo's:
 * the SDK constructors, port 4097, the text-or-tools delivery contract,
 * and the `kilo/`-prefix model parser. The exports keep their historical
 * names — the models module, one-shot runner, tests, and
 * `vi.mock("../backend/kilo/server.js")` all address them.
 */

import {
  createKiloClient,
  createKiloServer,
  type KiloClient,
} from "@kilocode/sdk/v2";
import {
  bindRemoteServer,
  type RemoteModelSelection,
} from "../remote-server/server-bindings.js";

/**
 * Parse the stored model-selection string into a `{providerID?, modelID}`
 * pair.
 *
 * Kilo model ids frequently contain `/` and `:` inside the model.id itself
 * (e.g. `inclusionai/ling-2.6-1t:free`, `deepseek/deepseek-v4-flash:free`).
 * A naive `provider/model` splitter mis-treats those vendor prefixes as
 * the provider, so we generally return the whole string as the model id
 * and let `resolveProviderID` look up the real provider from the live
 * catalog.
 *
 * Exception: if the value starts with the literal `kilo/` prefix
 * (Talon's old hint that "this is a kilo-routed model"), strip it AND
 * pin providerID to `"kilo"`. Otherwise the upstream Kilo router gets
 * `kilo/deepseek/deepseek-v4-flash:free` as the model id and concats
 * its own provider in front, producing
 * `Model not found: opencode/kilo/deepseek/deepseek-v4-flash:free`.
 */
export function parseStoredKiloModelSelection(
  value: string,
): RemoteModelSelection {
  const trimmed = value.trim();
  if (trimmed.startsWith("kilo/")) {
    return {
      providerID: "kilo",
      modelID: trimmed.slice("kilo/".length),
    };
  }
  return {
    providerID: undefined,
    modelID: trimmed,
  };
}

/**
 * Kilo delivery model: the reply reaches the user either as a `text` part
 * (what most Kilo-routed models emit by default — DeepSeek, GLM,
 * openrouter routes) or through a delivery tool (`end_turn` / `send` /
 * `react`) when reply-to targeting, buttons, photos, or polls are needed.
 * Both routes work; the shared text-or-tools contract documents the
 * choice.
 */
const kilo = bindRemoteServer<KiloClient>({
  label: "Kilo",
  defaultPort: 4097,
  portEnv: "KILO_PORT",
  deliveryContract: "text-or-tools",
  createClient: (baseUrl) => createKiloClient({ baseUrl, throwOnError: true }),
  createServer: ({ hostname, port, timeout }) =>
    createKiloServer({ hostname, port, timeout }),
  parseModelSelection: parseStoredKiloModelSelection,
});

export const KILO_BASE_URL = kilo.baseUrl;
export const kiloSystemPromptSuffix = kilo.systemPromptSuffix;
export const KILO_SYSTEM_PROMPT_SUFFIX = kilo.defaultSystemPromptSuffix;
export const initKiloAgent = kilo.init;
export const stopKiloServer = kilo.stop;
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
} = kilo;
