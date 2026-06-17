/**
 * Kilo model-catalog types.
 *
 * Kilo's underlying provider-bucket API is forked from OpenCode's, so the
 * internal type names retain the `OpenCode*` prefix to make the provenance
 * obvious. The exported public symbols mirror that naming for callers.
 */

import type { ReasoningEffortLevel } from "../../../core/types.js";

// ── Raw wire shapes (private) ────────────────────────────────────────────────

export type OpenCodeAuthMethod = {
  type?: string;
  label?: string;
};

export type OpenCodeRawModel = {
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

export type OpenCodeRawProvider = {
  id?: string;
  name?: string;
  source?: string;
  env?: Array<string>;
  key?: string;
  models?: Record<string, OpenCodeRawModel>;
};

export type OpenCodeProviderCatalogEntry = {
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

export type OpenCodeModelCatalogEntry = {
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

export type OpenCodeModelCatalog = {
  generatedAt: number;
  providers: Array<OpenCodeProviderCatalogEntry>;
  models: Array<OpenCodeModelCatalogEntry>;
  connectedProviders: Array<OpenCodeProviderCatalogEntry>;
  loginProviders: Array<OpenCodeProviderCatalogEntry>;
  connectedModels: Array<OpenCodeModelCatalogEntry>;
  connectedFreeModels: Array<OpenCodeModelCatalogEntry>;
};

export type OpenCodeModelResolution =
  | { kind: "exact"; model: OpenCodeModelCatalogEntry }
  | { kind: "ambiguous"; matches: Array<OpenCodeModelCatalogEntry> }
  | { kind: "missing"; matches: Array<OpenCodeModelCatalogEntry> };

export type ModelButton = { text: string; callback_data: string };
