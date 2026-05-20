/**
 * Agy model surface — minimal.
 *
 * The agy CLI doesn't expose a `--model` flag in `--print` mode; the
 * model selection lives inside the interactive session and is opaque
 * to external callers. So we surface a single "agy-default" entry to
 * satisfy the model-picker contract and otherwise stay out of the way.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  ModelPickerOptions,
  ModelPickerResult,
  UnifiedProviderInfo,
} from "../../core/types.js";
import { AGY_DEFAULT_MODEL } from "./constants.js";

const AGY_PROVIDER_ID = "agy";
const AGY_PROVIDER_NAME = "Antigravity (agy CLI)";

const AGY_MODEL: UnifiedModelInfo = {
  id: AGY_DEFAULT_MODEL,
  displayName: "agy (local OAuth)",
  provider: AGY_PROVIDER_ID,
  providerName: AGY_PROVIDER_NAME,
  selectable: true,
  free: false,
};

export async function listModels(
  _filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  return { models: [AGY_MODEL], total: 1 };
}

export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const q = query.trim().toLowerCase();
  if (q === "" || q === "default" || q === AGY_DEFAULT_MODEL || q === "agy") {
    return { kind: "exact", model: AGY_MODEL, storedValue: AGY_DEFAULT_MODEL };
  }
  return { kind: "missing" };
}

export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  return id === AGY_DEFAULT_MODEL ? AGY_MODEL : undefined;
}

export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  return [
    {
      id: AGY_PROVIDER_ID,
      name: AGY_PROVIDER_NAME,
      connected: true,
      modelCount: 1,
    },
  ];
}

export async function getProviderModels(
  providerId: string,
  _page?: number,
  _pageSize?: number,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (providerId !== AGY_PROVIDER_ID) return { models: [], total: 0 };
  return { models: [AGY_MODEL], total: 1 };
}

export function formatModelError(
  query: string,
  _resolution: UnifiedModelResolution,
): string {
  return `agy backend only exposes one model ("${AGY_DEFAULT_MODEL}"); got "${query}".`;
}

export async function getSettingsPresentation(
  _activeModel: string,
  _opts?: ModelPickerOptions,
): Promise<ModelPickerResult> {
  return {
    modelButtons: [
      {
        text: AGY_MODEL.displayName,
        callback_data: `settings:model:${AGY_DEFAULT_MODEL}`,
      },
    ],
    modelDetails: [
      "Agy uses whatever model the local `agy` CLI is configured for.",
      "Switch via the agy CLI itself; this backend has no per-turn override.",
    ],
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: 1,
    provider: AGY_PROVIDER_ID,
  };
}
