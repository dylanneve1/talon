/**
 * Antigravity model catalog.
 *
 * Antigravity exposes the full Gemini family. We list the most useful
 * variants here — pinned by name, not paginated dynamically (the
 * Gemini API doesn't expose a `/models` endpoint compatible with
 * Antigravity's model resolver, so we maintain the list by hand).
 *
 * If Dylan wants more options later, add an entry below. The
 * `selectable: false` flag hides retired models from `/model` without
 * dropping the row (so prior settings still resolve).
 */

import type {
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
} from "../../core/types.js";

export const ANTIGRAVITY_MODELS: UnifiedModelInfo[] = [
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-3-pro",
    displayName: "Gemini 3 Pro",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 2_000_000,
  },
  {
    id: "gemini-3.5-pro",
    displayName: "Gemini 3.5 Pro",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 2_000_000,
  },
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 2_000_000,
  },
];

export function resolveModel(query: string): UnifiedModelResolution {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  const exact = ANTIGRAVITY_MODELS.find((m) => m.id === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  const qLower = q.toLowerCase();
  const matches = ANTIGRAVITY_MODELS.filter(
    (m) =>
      m.id.toLowerCase().startsWith(qLower) ||
      m.displayName.toLowerCase().startsWith(qLower),
  );

  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  return { kind: "ambiguous", matches };
}

export function getModelInfo(id: string): UnifiedModelInfo | undefined {
  return ANTIGRAVITY_MODELS.find((m) => m.id === id);
}

export function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): ModelPickerResult {
  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const modelButtons: ModelButton[] = ANTIGRAVITY_MODELS.filter(
    (m) => m.selectable,
  ).map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  const active = ANTIGRAVITY_MODELS.find((m) => m.id === activeModel);
  const modelDetails: string[] = [];
  if (active) {
    const ctx = active.contextWindow
      ? ` — ${Math.round(active.contextWindow / 1000)}k ctx`
      : "";
    modelDetails.push(`Active: ${active.displayName} (${active.id})${ctx}`);
  }
  modelDetails.push(
    `Backend: Antigravity — ${ANTIGRAVITY_MODELS.length} models`,
  );

  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: ANTIGRAVITY_MODELS.length,
  };
}

export function getProviders(): UnifiedProviderInfo[] {
  return [
    {
      id: "google",
      name: "Google",
      connected: true,
      modelCount: ANTIGRAVITY_MODELS.length,
    },
  ];
}

export function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): { models: UnifiedModelInfo[]; total: number } {
  if (providerId !== "google") return { models: [], total: 0 };
  const start = (page - 1) * pageSize;
  return {
    models: ANTIGRAVITY_MODELS.slice(start, start + pageSize),
    total: ANTIGRAVITY_MODELS.length,
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
  return (
    `No Antigravity model matches \`${query}\`. ` +
    `Available: ${ANTIGRAVITY_MODELS.map((m) => m.id).join(", ")}.`
  );
}

export function listModels(filter?: "free" | "all"): {
  models: UnifiedModelInfo[];
  total: number;
} {
  // Gemini API has a free tier on Google AI Studio, but the entry-tier
  // status depends on user-side billing config — we can't honestly
  // surface free-tier markers from the catalog alone. Return empty
  // for `free` so the `/model free` slash-command produces an honest
  // "(no free models)" rather than mislabeling something paid.
  if (filter === "free") {
    return { models: [], total: 0 };
  }
  return { models: ANTIGRAVITY_MODELS, total: ANTIGRAVITY_MODELS.length };
}
