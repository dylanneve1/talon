/**
 * OpenCode — a remote-server profile.
 *
 * The whole driver is `bindRemoteProfile` over the constants below: the
 * `@opencode-ai/sdk` constructors, port 4096, the text-preferred
 * delivery contract, the fuzzy `provider/model` parser, and the
 * Telegram-sized model picker budget.
 *
 * Text-preferred delivery: plain assistant text is the reply; tools only
 * for genuine side effects. Single-sourced from the shared contract
 * templates (prompts/system/contract-text-preferred.md).
 */

import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import {
  normalizeModelLookup,
  parseRemoteModelQuery,
} from "../model-catalog/index.js";
import type { RemoteModelSelection } from "../server-bindings.js";
import { bindRemoteProfile, type RemoteProfile } from "./bind.js";

/**
 * Parse the stored model-selection string into a `{providerID?, modelID}`
 * pair. The parser is fuzzy — it tries to extract a provider hint from the
 * prefix while preserving the full model id when ambiguous. See
 * `remote-server/model-catalog/` for the underlying `parseRemoteModelQuery`.
 */
function parseStoredOpenCodeModelSelection(
  value: string,
): RemoteModelSelection {
  const { providerQuery, modelQuery } = parseRemoteModelQuery(value);
  return {
    providerID: providerQuery ? normalizeModelLookup(providerQuery) : undefined,
    modelID: modelQuery,
  };
}

export const opencodeProfile: RemoteProfile<OpencodeClient> =
  bindRemoteProfile<OpencodeClient>({
    id: "opencode",
    label: "OpenCode",
    sdkPackage: "@opencode-ai/sdk",
    defaultPort: 4096,
    portEnv: "OPENCODE_PORT",
    deliveryContract: "text-preferred",
    createClient: (baseUrl) =>
      createOpencodeClient({ baseUrl, throwOnError: true }),
    createServer: ({ hostname, port, timeout }) =>
      createOpencodeServer({ hostname, port, timeout }),
    parseModelSelection: parseStoredOpenCodeModelSelection,
    // OpenCode's model picker renders through Telegram inline keyboards —
    // callback_data caps at 64 bytes and the keyboard is tight, so quick
    // picks stay at 4 and only short separator-free ids are embedded raw.
    maxCallbackIdLength: 48,
    allowCallbackSeparators: false,
    quickPickLimit: 4,
  });
