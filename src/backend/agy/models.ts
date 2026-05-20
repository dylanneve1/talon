/**
 * Agy model surface.
 *
 * The agy CLI doesn't expose a `--model` flag — model selection is a
 * **server-side per-account preference**, set via the interactive
 * `agy` REPL (or via Google's Code Assist settings). `agy --print`
 * always uses whatever model the signed-in account currently has
 * selected; Talon can't override per-turn.
 *
 * Given that, we still surface the catalog of known Gemini models
 * agy supports — extracted from the binary's embedded model
 * identifiers — so `/model` is informational instead of empty.
 * Selecting a model in the picker stores the choice in
 * `chat-settings.json` (so `/status` reflects what the user thinks
 * is active) but does **not** force agy to use it. The picker text
 * spells this out.
 */

import type {
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
} from "../../core/types.js";

const AGY_PROVIDER_ID = "agy";
const AGY_PROVIDER_NAME = "Antigravity (agy CLI)";

// Model identifiers agy advertises. The agy binary embeds a subset
// (`strings agy | grep gemini-`); the *active* catalogue is fetched
// server-side per account and can extend beyond what's compiled in
// (e.g. Gemini 3.5 Flash on the picker even though the binary
// references 3.1-flash-lite-preview). We surface the union of:
//
//   - binary-embedded ids — known-supported across deployments,
//   - user-visible display labels seen in transcript.jsonl —
//     `Gemini 3.5 Flash (High)` etc., which appear in the
//     `User changed setting Model Selection from None to <label>`
//     entries when agy launches.
//
// The picker is read-only — agy enforces the model server-side, our
// selection just labels `/status`. So adding extra entries can't
// break agy; at worst the user picks a label that won't survive a
// round-trip and `/status` shows an unfamiliar id until they re-pick.
const AGY_MODELS: UnifiedModelInfo[] = [
  {
    id: "gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-3-pro-preview",
    displayName: "Gemini 3 Pro (preview)",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    reasoning: true,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash (preview)",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-3.1-pro",
    displayName: "Gemini 3.1 Pro",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    reasoning: true,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash-Lite (preview)",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    reasoning: true,
    contextWindow: 2_000_000,
  },
  {
    id: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    contextWindow: 1_000_000,
  },
  {
    id: "gemini-2.5-flash-lite",
    displayName: "Gemini 2.5 Flash-Lite",
    provider: AGY_PROVIDER_ID,
    providerName: AGY_PROVIDER_NAME,
    selectable: true,
    free: false,
    contextWindow: 1_000_000,
  },
];

const AGY_DEFAULT_ID = "gemini-3.5-flash";

function normalize(id: string): string {
  // Accept both bare ids and `models/<id>` (the antigravity backend
  // ships the prefixed form; users may type either).
  return id.replace(/^models\//, "").trim();
}

export async function listModels(
  _filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  return { models: AGY_MODELS, total: AGY_MODELS.length };
}

export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const q = normalize(query).toLowerCase();
  if (q === "" || q === "default" || q === "agy") {
    const m = AGY_MODELS.find((x) => x.id === AGY_DEFAULT_ID)!;
    return { kind: "exact", model: m, storedValue: m.id };
  }
  const exact = AGY_MODELS.find((m) => m.id.toLowerCase() === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  // Prefix / contains match — convenient for chat commands like
  // `/model flash-lite` or `/model 3.1`.
  const matches = AGY_MODELS.filter((m) => m.id.toLowerCase().includes(q));
  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }
  return { kind: "missing" };
}

export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  const norm = normalize(id);
  return AGY_MODELS.find((m) => m.id === norm);
}

export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  return [
    {
      id: AGY_PROVIDER_ID,
      name: AGY_PROVIDER_NAME,
      connected: true,
      modelCount: AGY_MODELS.length,
    },
  ];
}

export async function getProviderModels(
  providerId: string,
  _page?: number,
  _pageSize?: number,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (providerId !== AGY_PROVIDER_ID) return { models: [], total: 0 };
  return { models: AGY_MODELS, total: AGY_MODELS.length };
}

export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const ids = resolution.matches.map((m) => m.id).join(", ");
    return `"${query}" matches multiple agy models: ${ids}. Be more specific.`;
  }
  const ids = AGY_MODELS.map((m) => m.id).join(", ");
  return `Unknown agy model "${query}". Known: ${ids}.`;
}

export async function getSettingsPresentation(
  activeModel: string,
  options?: ModelPickerOptions,
): Promise<ModelPickerResult> {
  const callbackPrefix = options?.callbackPrefix ?? "settings:model:";
  const norm = normalize(activeModel);
  const modelButtons: ModelButton[] = AGY_MODELS.map((m) => ({
    text: `${m.id === norm ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));
  const active = AGY_MODELS.find((m) => m.id === norm);
  const modelDetails: string[] = [];
  if (active) {
    const ctx = active.contextWindow
      ? ` — ${Math.round(active.contextWindow / 1_000)}k ctx`
      : "";
    modelDetails.push(`Active: ${active.displayName} (${active.id})${ctx}`);
  } else if (norm) {
    modelDetails.push(`Selected: ${norm} (not in agy's known catalog)`);
  }
  modelDetails.push(
    "Note: agy picks its model server-side per account. Selecting here " +
      "updates the displayed model only — switch the actual model via the " +
      "agy CLI (`agy` interactive, then `/model`).",
  );
  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: AGY_MODELS.length,
    provider: AGY_PROVIDER_ID,
  };
}
