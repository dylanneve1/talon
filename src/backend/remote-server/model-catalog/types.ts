/**
 * Remote-server model-catalog types.
 *
 * OpenCode and Kilo (a fork of OpenCode) expose the same `/provider/list` +
 * `/provider/auth` wire shapes, so the raw and parsed catalog types live here
 * once and each backend re-exports them under its own prefix for back-compat.
 */

import type { ReasoningEffortLevel } from "../../../core/types.js";

// ── Raw wire shapes (private) ────────────────────────────────────────────────

export type RemoteAuthMethod = {
  type?: string;
  label?: string;
};

export type RemoteRawModel = {
  id?: string;
  providerID?: string;
  name?: string;
  family?: string;
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: {
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
    supportedReasoningLevels?: string[];
    supported_reasoning_levels?: string[];
  };
  options?: Record<string, unknown>;
  supportedReasoningLevels?: string[];
  supported_reasoning_levels?: string[];
  defaultReasoningLevel?: string;
  default_reasoning_level?: string;
};

export type RemoteRawProvider = {
  id?: string;
  name?: string;
  source?: string;
  env?: Array<string>;
  key?: string;
  models?: Record<string, RemoteRawModel>;
};

/** The `/provider/list` response body both backends return. */
export type RemoteRawProvidersData = {
  all?: Array<RemoteRawProvider>;
  connected?: Array<string>;
  default?: Record<string, string>;
};

export type RemoteProviderCatalogEntry = {
  id: string;
  name: string;
  source: string;
  connected: boolean;
  envKeys: Array<string>;
  authMethods: Array<string>;
  defaultModel?: string;
  modelCount: number;
  loginRequired: boolean;
  envRequired: boolean;
};

// ── Public catalog shapes ────────────────────────────────────────────────────

export type RemoteModelCatalogEntry = {
  id: string;
  name: string;
  family?: string;
  providerID: string;
  providerName: string;
  providerSource: string;
  connected: boolean;
  selectable: boolean;
  loginRequired: boolean;
  envRequired: boolean;
  authMethods: Array<string>;
  free: boolean;
  status: string;
  contextWindow: number;
  inputWindow?: number;
  outputWindow: number;
  reasoning: boolean;
  supportedReasoningLevels?: ReasoningEffortLevel[];
  defaultReasoningLevel?: ReasoningEffortLevel;
  attachment: boolean;
  toolcall: boolean;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
};

export type RemoteModelCatalog = {
  generatedAt: number;
  providers: Array<RemoteProviderCatalogEntry>;
  models: Array<RemoteModelCatalogEntry>;
  connectedProviders: Array<RemoteProviderCatalogEntry>;
  loginProviders: Array<RemoteProviderCatalogEntry>;
  connectedModels: Array<RemoteModelCatalogEntry>;
  connectedFreeModels: Array<RemoteModelCatalogEntry>;
};

export type RemoteModelResolution =
  | { kind: "exact"; model: RemoteModelCatalogEntry }
  | { kind: "ambiguous"; matches: Array<RemoteModelCatalogEntry> }
  | { kind: "missing"; matches: Array<RemoteModelCatalogEntry> };

export type ModelButton = { text: string; callback_data: string };

/**
 * Structural slice of the OpenCode/Kilo SDK client the catalog fetch needs.
 * Both `OpencodeClient` and `KiloClient` satisfy it.
 */
export interface RemoteProviderClient {
  provider: {
    list(): Promise<{ data?: unknown }>;
    auth(): Promise<{ data?: unknown }>;
  };
}
