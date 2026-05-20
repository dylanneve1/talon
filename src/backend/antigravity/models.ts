/**
 * Antigravity model catalog — dynamic via Gemini's `models.list` API.
 *
 * Hard-coding the Gemini catalog was technical debt — model
 * availability is per-API-key (billing tier, region, preview access),
 * and Google adds models regularly. This module talks to
 * `discovery.ts` which spawns a Python helper to query
 * `google.genai.Client(...).models.list()`.
 *
 * The catalog read functions are sync (UnifiedModelResolution etc.
 * are sync). They read whatever's currently cached. The init code +
 * `/model` refresh trigger the async discovery; before discovery
 * completes the catalog falls back to a curated 5-model list.
 *
 * To kick off discovery proactively (e.g. on backend init), call
 * `discoverAntigravityModels({ apiKey })`. The init module does this.
 */

import type {
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
} from "../../core/types.js";

import {
  discoverAntigravityModels,
  getCachedAntigravityModels,
  refreshAntigravityCatalog,
} from "./discovery.js";

/** Re-exports so the rest of the backend can trigger discovery / refresh. */
export {
  discoverAntigravityModels,
  refreshAntigravityCatalog,
} from "./discovery.js";

/**
 * Get the current catalog snapshot. Always sync — backed by the
 * discovery module's in-process cache. Callers wanting fresh data
 * should `await discoverAntigravityModels()` first.
 */
function catalog(): UnifiedModelInfo[] {
  return getCachedAntigravityModels();
}

/**
 * Back-compat export for tests + external consumers that imported
 * the catalog as a constant in v0. Reads the cache each access so
 * dynamic refreshes are visible.
 */
export const ANTIGRAVITY_MODELS = new Proxy([] as UnifiedModelInfo[], {
  get(_target, prop, receiver) {
    const live = catalog();
    return Reflect.get(live, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(catalog(), prop);
  },
  ownKeys() {
    return Reflect.ownKeys(catalog());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(catalog(), prop);
  },
});

export function resolveModel(query: string): UnifiedModelResolution {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  const models = catalog();

  // Exact-id match — accept both the canonical `models/<x>` form and
  // the bare `<x>` form for ergonomic CLI / chat use.
  const exact = models.find((m) => m.id === q || stripModelsPrefix(m.id) === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  const qLower = q.toLowerCase();
  const matches = models.filter(
    (m) =>
      m.id.toLowerCase().startsWith(qLower) ||
      stripModelsPrefix(m.id).toLowerCase().startsWith(qLower) ||
      m.displayName.toLowerCase().startsWith(qLower),
  );

  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  return { kind: "ambiguous", matches };
}

export function getModelInfo(id: string): UnifiedModelInfo | undefined {
  const models = catalog();
  return (
    models.find((m) => m.id === id) ||
    models.find((m) => stripModelsPrefix(m.id) === id)
  );
}

export function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): ModelPickerResult {
  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const models = catalog();
  const modelButtons: ModelButton[] = models
    .filter((m) => m.selectable)
    .map((m) => ({
      text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
      callback_data: `${callbackPrefix}${m.id}`,
    }));

  const active = models.find((m) => m.id === activeModel);
  const modelDetails: string[] = [];
  if (active) {
    const ctx = active.contextWindow
      ? ` — ${Math.round(active.contextWindow / 1000)}k ctx`
      : "";
    modelDetails.push(`Active: ${active.displayName} (${active.id})${ctx}`);
  }
  modelDetails.push(`Backend: Antigravity — ${models.length} models`);

  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: models.length,
  };
}

export function getProviders(): UnifiedProviderInfo[] {
  return [
    {
      id: "google",
      name: "Google",
      connected: true,
      modelCount: catalog().length,
    },
  ];
}

export function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): { models: UnifiedModelInfo[]; total: number } {
  if (providerId !== "google") return { models: [], total: 0 };
  const all = catalog();
  const start = (page - 1) * pageSize;
  return {
    models: all.slice(start, start + pageSize),
    total: all.length,
  };
}

export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple Antigravity models match \`${query}\`: ${list}. Pick one.`;
  }
  const sample = catalog()
    .slice(0, 5)
    .map((m) => stripModelsPrefix(m.id))
    .join(", ");
  return (
    `No Antigravity model matches \`${query}\`. ` +
    `Sample: ${sample}${catalog().length > 5 ? ", …" : ""}. ` +
    `Run \`/model refresh\` or wait for discovery to repopulate the catalog.`
  );
}

export function listModels(filter?: "free" | "all"): {
  models: UnifiedModelInfo[];
  total: number;
} {
  const all = catalog();
  if (filter === "free") {
    // Gemini API has a free tier on Google AI Studio, but per-key
    // billing means we can't honestly mark any specific model "free"
    // from the catalog alone.
    return { models: [], total: 0 };
  }
  return { models: all, total: all.length };
}

function stripModelsPrefix(id: string): string {
  return id.replace(/^models\//, "");
}
