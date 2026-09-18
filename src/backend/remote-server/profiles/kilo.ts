/**
 * Kilo — a remote-server profile.
 *
 * Kilo is a fork of OpenCode and exposes the same HTTP API, so the whole
 * driver is `bindRemoteProfile` over the constants below: the
 * `@kilocode/sdk` constructors, port 4097, the text-or-tools delivery
 * contract, the `kilo/`-prefix model parser, and the Discord-sized model
 * picker budget.
 *
 * Kilo delivery model: the reply reaches the user either as a `text`
 * part (what most Kilo-routed models emit by default — DeepSeek, GLM,
 * openrouter routes) or through a delivery tool (`end_turn` / `send` /
 * `react`) when reply-to targeting, buttons, photos, or polls are
 * needed. Both routes work; the shared text-or-tools contract documents
 * the choice.
 *
 * Note: the model catalog's internal type names are `Remote*` and its
 * wire shape is OpenCode's — Kilo's provider-bucket API is forked from
 * it, so the names match what the upstream actually emits.
 */

import {
  createKiloClient,
  createKiloServer,
  type KiloClient,
} from "@kilocode/sdk/v2";
import type { RemoteModelSelection } from "../server-bindings.js";
import { bindRemoteProfile, type RemoteProfile } from "./bind.js";

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
function parseStoredKiloModelSelection(value: string): RemoteModelSelection {
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

export const kiloProfile: RemoteProfile<KiloClient> =
  bindRemoteProfile<KiloClient>({
    id: "kilo",
    label: "Kilo",
    sdkPackage: "@kilocode/sdk",
    defaultPort: 4097,
    portEnv: "KILO_PORT",
    deliveryContract: "text-or-tools",
    createClient: (baseUrl) =>
      createKiloClient({ baseUrl, throwOnError: true }),
    createServer: ({ hostname, port, timeout }) =>
      createKiloServer({ hostname, port, timeout }),
    parseModelSelection: parseStoredKiloModelSelection,
    // Kilo's model picker renders through Discord StringSelectMenus,
    // which allow 25 options and values up to 100 chars with any
    // characters — Kilo ids routinely contain "/" and ":" (e.g.
    // "inclusionai/ling-2.6-1t:free").
    maxCallbackIdLength: 90,
    allowCallbackSeparators: true,
    quickPickLimit: 24,
  });
