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
  ModelPickerOptions,
  ModelPickerResult,
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

const DEFAULT_PAGE_SIZE = 8;
const MAX_PAGE_SIZE = 24;
/**
 * Catalog size beyond which we surface provider chips instead of a
 * flat paginated model list. Matches openclaw's `PROVIDER_FILTER_THRESHOLD`
 * (`/tmp/openclaw/src/flows/model-picker.ts`) so the UX scales the
 * same way: small catalogs stay flat, large ones get a provider
 * grouping step first.
 */
const PROVIDER_GROUP_THRESHOLD = 30;

/**
 * Inline-button picker for /settings. The picker is two-stage when
 * the filtered catalog has more than `PROVIDER_GROUP_THRESHOLD`
 * entries (typical for OpenRouter with 350+ models):
 *
 *   1. `view: "groups"` — provider chips (Anthropic, OpenAI, Google…).
 *      Tapping one re-invokes with `options.provider` set.
 *   2. `view: "models"` — that provider's models, paginated.
 *
 * Smaller catalogs (and any catalog drilled into a single provider)
 * skip step 1 and render the model list directly. `modelDetails`
 * carries only a backend-status line; the caller renders the active
 * model header from its own data.
 */
export function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): ModelPickerResult {
  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const navPrefix = options.navCallbackPrefix ?? "settings:models";
  const filter = options.filter ?? "all";
  // Telegram's inline-button `callback_data` is capped at 64 bytes
  // (https://core.telegram.org/bots/api#inlinekeyboardbutton). Other
  // chat platforms (Discord, Slack) typically allow more, but 64 is
  // the lowest common denominator so we treat it as the universal
  // budget. Any model whose `<prefix><id>` payload would overflow is
  // hidden from the button surface; operators can still target it
  // via `/model <id>`.
  const PLATFORM_CALLBACK_BUDGET = 64;
  const callbackBudget = PLATFORM_CALLBACK_BUDGET - byteLen(callbackPrefix);
  const pageSize = clamp(
    options.pageSize ?? DEFAULT_PAGE_SIZE,
    1,
    MAX_PAGE_SIZE,
  );

  const all = snapshot().filter((m) => byteLen(m.id) <= callbackBudget);
  const filtered = filter === "free" ? all.filter((m) => m.free) : all;
  const freeCount = all.reduce((n, m) => (m.free ? n + 1 : n), 0);

  const modelDetails = buildStatusDetails(all);
  const baseResult = {
    modelDetails,
    filter,
    freeCount,
    totalCount: all.length,
  } as const;

  // Group-view branch: only when no provider is selected AND the
  // filtered catalog is big enough to benefit. Tapping a provider
  // sends the same callbackPrefix scheme back, but with the prefix
  // changed to a "drill" form (`settings:models:provider:<id>`)
  // which the frontend recognises.
  const useGroupView =
    !options.provider && filtered.length > PROVIDER_GROUP_THRESHOLD;
  if (useGroupView) {
    const groups = groupByProvider(filtered);
    const modelButtons: ModelButton[] = groups.map(({ provider, count }) => ({
      text: `${humanizeProvider(provider)} (${count})`,
      callback_data: `${navPrefix}:provider:${provider}`,
    }));
    return {
      ...baseResult,
      modelButtons,
      view: "groups",
      page: 1,
      totalPages: 1,
    };
  }

  // Model-view branch: either we drilled into a provider, the
  // catalog is small enough not to need grouping, or the free
  // filter has reduced it below the grouping threshold.
  const scoped = options.provider
    ? filtered.filter((m) => providerOf(m.id) === options.provider)
    : filtered;
  const totalPages = Math.max(1, Math.ceil(scoped.length / pageSize));
  const page = clamp(options.page ?? 1, 1, totalPages);
  const start = (page - 1) * pageSize;
  const visible = scoped.slice(start, start + pageSize);

  const modelButtons: ModelButton[] = visible.map((m) => ({
    text: formatButtonLabel(m, m.id === activeModel),
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  return {
    ...baseResult,
    modelButtons,
    view: "models",
    page,
    totalPages,
    ...(options.provider ? { provider: options.provider } : {}),
  };
}

function providerOf(id: string): string {
  // OpenRouter ids look like `vendor/model`. Some have a leading
  // tilde (router shortcuts) — treat `~vendor/model` as `vendor`.
  const stripped = id.startsWith("~") ? id.slice(1) : id;
  const slash = stripped.indexOf("/");
  return slash >= 0 ? stripped.slice(0, slash) : "openai";
}

function groupByProvider(
  models: UnifiedModelInfo[],
): Array<{ provider: string; count: number }> {
  const counts = new Map<string, number>();
  for (const m of models) {
    const p = providerOf(m.id);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const groups = Array.from(counts, ([provider, count]) => ({
    provider,
    count,
  }));
  // Largest first — common providers (anthropic, openai, google)
  // float to the top; long-tail providers fall after.
  groups.sort(
    (a, b) => b.count - a.count || a.provider.localeCompare(b.provider),
  );
  return groups;
}

function humanizeProvider(p: string): string {
  // Title-case ids like "anthropic" → "Anthropic", "aion-labs" → "Aion Labs".
  return p
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildStatusDetails(all: UnifiedModelInfo[]): string[] {
  if (all.length === 0) return [];
  const enriched = all.reduce(
    (n, m) => (m.contextWindow !== undefined ? n + 1 : n),
    0,
  );
  return [
    `${all.length} model${all.length === 1 ? "" : "s"} discovered via OpenAI Agents endpoint` +
      (enriched > 0 ? `, ${enriched} with context info` : ""),
  ];
}

function formatButtonLabel(m: UnifiedModelInfo, isActive: boolean): string {
  const prefix = isActive ? "● " : "";
  // Strip vendor prefix (e.g. "openrouter/owl-alpha" → "owl-alpha") to
  // keep button text short; full id is in the callback data anyway.
  const slash = m.id.lastIndexOf("/");
  const short = slash >= 0 ? m.id.slice(slash + 1) : m.id;
  const ctx = m.contextWindow ? ` ${formatTokens(m.contextWindow)}` : "";
  const free = m.free ? " ·🆓" : "";
  return `${prefix}${short}${ctx}${free}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function byteLen(s: string): number {
  // Telegram counts callback_data in UTF-8 bytes, not characters.
  // Reuse Buffer to match server-side accounting exactly.
  return Buffer.byteLength(s, "utf8");
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
