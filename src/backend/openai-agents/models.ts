/**
 * OpenAI Agents backend model surface.
 *
 * Design note: there is **no** hardcoded model catalog here. The
 * Agents SDK speaks to any OpenAI-compatible endpoint (OpenAI itself,
 * OpenRouter, Azure, Ollama, LiteLLM, vLLM, etc.), each of which
 * advertises its own model set via `GET /models`. Maintaining a
 * static list in Talon would either be wrong-by-default (the day
 * OpenAI ships a new model) or wrong-by-provider (OpenRouter's 350+
 * models, Ollama's user-installed models, Azure's deployment ids).
 *
 * Instead, `init.ts#fetchEndpointModels` populates
 * `state.endpointModels` at startup with whatever the active
 * endpoint reports. Every public function in this file derives its
 * answer from that map. If a query asks about a model the endpoint
 * never mentioned, we still hand back a bare passthrough — the user
 * (or `talon.json`) may know about ids the discovery call missed.
 *
 * Note: `gpt-5-codex` is intentionally NOT used here. That model is
 * exposed via the Codex CLI only, not the public Responses API.
 * Users who want `gpt-5-codex` should pick the `codex` backend.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
} from "../../core/types.js";
import { getState, type EndpointModelCapabilities } from "./state.js";

// ── Internal: id → ModelInfo projection ─────────────────────────────────────

/**
 * Build a `UnifiedModelInfo` from a model id and its discovered
 * capabilities. Capabilities are optional — when absent, the model
 * is treated as a bare passthrough (id only, no context window, no
 * free-pricing flag). The `provider` / `providerName` fields fall
 * back to a generic "OpenAI-compatible endpoint" since this backend
 * is by design provider-agnostic.
 */
function makeModelInfo(
  id: string,
  caps?: EndpointModelCapabilities,
): UnifiedModelInfo {
  return {
    id,
    displayName: caps?.displayName ?? id,
    provider: "openai-compatible",
    providerName: "OpenAI-compatible endpoint",
    selectable: true,
    reasoning: false,
    ...(caps?.contextWindow ? { contextWindow: caps.contextWindow } : {}),
    ...(caps?.free ? { free: true } : {}),
  };
}

/**
 * Snapshot of the discovered catalog as a sorted list. Sorted by id
 * for stable UI ordering; the underlying Map preserves insertion
 * order from the `/models` response which is arbitrary across
 * providers.
 */
function snapshot(): UnifiedModelInfo[] {
  const out: UnifiedModelInfo[] = [];
  for (const [id, caps] of getState().endpointModels) {
    out.push(makeModelInfo(id, caps));
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve a user query against the discovered catalog.
 *
 *   1. Exact id match  — returned immediately.
 *   2. Case-insensitive prefix match on id or display name —
 *      returned when exactly one model matches; ambiguous when more
 *      than one.
 *   3. No match — accepted as a passthrough so operators can target
 *      ids that the discovery call missed (e.g. brand-new releases,
 *      private deployments, Ollama models added after Talon started).
 *
 * Returns `missing` only for an empty/whitespace query, since any
 * non-empty id can be passed through.
 */
export function resolveModel(query: string): UnifiedModelResolution {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  const catalog = getState().endpointModels;

  const exact = catalog.get(q);
  if (exact !== undefined) {
    return { kind: "exact", model: makeModelInfo(q, exact), storedValue: q };
  }

  const qLower = q.toLowerCase();
  const matches: Array<{ id: string; caps: EndpointModelCapabilities }> = [];
  for (const [id, caps] of catalog) {
    const idMatch = id.toLowerCase().startsWith(qLower);
    const nameMatch = (caps.displayName ?? "").toLowerCase().startsWith(qLower);
    if (idMatch || nameMatch) matches.push({ id, caps });
  }

  if (matches.length === 1) {
    const m = matches[0];
    return {
      kind: "exact",
      model: makeModelInfo(m.id, m.caps),
      storedValue: m.id,
    };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      matches: matches.map((m) => makeModelInfo(m.id, m.caps)),
    };
  }

  // No catalog hit — fall through to a bare passthrough. The endpoint
  // may legitimately accept ids it doesn't advertise.
  return { kind: "exact", model: makeModelInfo(q), storedValue: q };
}

/**
 * Look up a model by stored id. Returns enriched metadata when the
 * discovery call covered this id, otherwise a bare passthrough so
 * /status and /settings can render something for unknown-but-valid
 * ids instead of "unknown model".
 */
export function getModelInfo(id: string): UnifiedModelInfo | undefined {
  if (!id) return undefined;
  const caps = getState().endpointModels.get(id);
  return makeModelInfo(id, caps);
}

// ── /settings presentation ──────────────────────────────────────────────────

const SETTINGS_PICKER_LIMIT = 12;

/**
 * Inline-button picker shown in /settings. The discovered catalog
 * can be huge (OpenRouter ships 350+ models); we cap the picker at
 * a handful for visibility and let operators set unlisted ids
 * directly in `talon.json` or via `/model <id>`.
 *
 * Selection heuristic: prefer the active model, then anything with a
 * known context window (more useful than bare passthroughs), then
 * everything else. Stable id-sorted within each tier.
 */
export function getSettingsPresentation(
  activeModel: string,
  callbackPrefix = "settings:model:",
): { modelButtons: ModelButton[]; modelDetails: string[] } {
  const all = snapshot();
  const active = all.find((m) => m.id === activeModel);

  const enriched = all.filter(
    (m) => m.id !== activeModel && m.contextWindow !== undefined,
  );
  const bare = all.filter(
    (m) => m.id !== activeModel && m.contextWindow === undefined,
  );

  const ordered: UnifiedModelInfo[] = [];
  if (active) ordered.push(active);
  ordered.push(...enriched, ...bare);
  const visible = ordered.slice(0, SETTINGS_PICKER_LIMIT);

  const modelButtons: ModelButton[] = visible.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  const modelDetails = visible.map((m) => {
    const flags: string[] = [];
    if (m.reasoning) flags.push("reasoning");
    if (m.contextWindow)
      flags.push(`${Math.round(m.contextWindow / 1000)}k ctx`);
    if (m.free) flags.push("free");
    const tag = flags.length > 0 ? ` — ${flags.join(" · ")}` : "";
    return `**${m.displayName}** (\`${m.id}\`)${tag}`;
  });

  return { modelButtons, modelDetails };
}

// ── Provider / list ────────────────────────────────────────────────────────

/**
 * A single "provider" entry covering whichever endpoint is currently
 * configured. The backend stays provider-agnostic so we don't try to
 * split this further by inferring from baseURL — operators who care
 * see the actual endpoint url in `OpenAI Agents auth: ...` at
 * startup.
 */
export function getProviders(): UnifiedProviderInfo[] {
  const count = getState().endpointModels.size;
  return [
    {
      id: "openai",
      name: "OpenAI Agents endpoint",
      connected: true,
      modelCount: count,
    },
  ];
}

/** List models for a provider (paginated). */
export function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): { models: UnifiedModelInfo[]; total: number } {
  if (providerId !== "openai") return { models: [], total: 0 };
  const all = snapshot();
  const start = (page - 1) * pageSize;
  return {
    models: all.slice(start, start + pageSize),
    total: all.length,
  };
}

/** Format a human-readable error for an unresolvable model query. */
export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple OpenAI Agents models match \`${query}\`: ${list}. Pick one.`;
  }
  // `missing` only fires for empty queries since unknown non-empty
  // ids resolve to a passthrough.
  return `No model id supplied — provide one (e.g. \`gpt-5.5\`, \`openrouter/owl-alpha\`).`;
}

/** Filter the catalog by a coarse-grained tag. */
export function listModels(filter?: "free" | "all"): {
  models: UnifiedModelInfo[];
  total: number;
} {
  const all = snapshot();
  if (filter === "free") {
    const free = all.filter((m) => m.free === true);
    return { models: free, total: free.length };
  }
  return { models: all, total: all.length };
}
