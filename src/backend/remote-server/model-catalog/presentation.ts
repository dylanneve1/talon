/**
 * Remote model presentation — quick-pick selection, settings-panel buttons,
 * summary/list rendering, and selection-error formatting.
 *
 * Rendering logic is shared; the backend label and the frontend-driven
 * knobs (callback-value budget, quick-pick count) are injected per backend
 * via `createRemoteModelPresentation`.
 */

import type {
  ModelButton,
  RemoteModelCatalog,
  RemoteModelCatalogEntry,
  RemoteModelResolution,
} from "./types.js";
import {
  getRemoteModelInfo,
  getRemoteModelSelectionValue,
  resolveRemoteModelInput,
} from "./resolve.js";

/** Frontend-driven presentation knobs, tuned per backend. */
export interface RemotePresentationOptions {
  /** Human label used in summary/list headers and error strings. */
  label: string;
  /** Catalog getter, bound to the backend's TTL store. */
  getCatalog: (forceRefresh?: boolean) => Promise<RemoteModelCatalog>;
  /**
   * Longest model id that may be embedded raw in a button callback value
   * (Telegram callback_data caps at 64 bytes; Discord select values at 100).
   */
  maxCallbackIdLength: number;
  /**
   * Whether ids containing "/" or ":" may appear in callback values —
   * true where the transport accepts arbitrary characters (Discord).
   */
  allowCallbackSeparators: boolean;
  /**
   * Default page size when the frontend doesn't ask for one — also the
   * legacy quick-pick count (Telegram 4, Discord 24).
   */
  quickPickLimit: number;
  /**
   * Flat model lists longer than this collapse into provider chips, so a
   * catalog of several hundred models opens as a handful of providers
   * rather than dozens of indistinguishable pages. Defaults to 60.
   */
  groupThreshold?: number;
}

/** Paging / filtering knobs, mirroring `ModelPickerOptions`. */
export interface RemotePickerOptions {
  callbackPrefix?: string;
  navCallbackPrefix?: string;
  page?: number;
  pageSize?: number;
  filter?: "all" | "free";
  provider?: string;
}

/** What the frontend needs to render one page of the picker. */
export interface RemotePickerResult {
  modelButtons: Array<ModelButton>;
  modelDetails: Array<string>;
  view: "groups" | "models";
  page: number;
  totalPages: number;
  filter: "all" | "free";
  freeCount: number;
  totalCount: number;
  provider?: string;
}

function getAvailabilityLabel(model: RemoteModelCatalogEntry) {
  if (model.selectable) return model.free ? "ready · free" : "ready";
  if (model.loginRequired) return "login required";
  if (model.envRequired) return "credentials required";
  return "not connected";
}

function formatCtxWindow(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export function formatRemoteUnavailableModel(
  model: RemoteModelCatalogEntry,
): string {
  if (model.loginRequired)
    return `${model.providerName} isn't connected yet. Login methods: ${model.authMethods.join(", ")}.`;
  if (model.envRequired)
    return `${model.providerName} needs credentials/env setup before ${model.id} can be used.`;
  return `${model.providerName} isn't connected, so ${model.id} can't be selected yet.`;
}

export interface RemoteModelPresentation {
  getQuickPickModels(
    catalog: RemoteModelCatalog,
    currentModelID?: string,
  ): Array<RemoteModelCatalogEntry>;
  getSettingsPresentation(
    activeModel: string,
    options?: RemotePickerOptions,
  ): Promise<RemotePickerResult>;
  renderModelSummary(
    activeModel: string,
    defaultModel: string,
  ): Promise<{ text: string; quickButtons: Array<ModelButton> }>;
  renderModelList(mode: "free" | "all" | "providers"): Promise<string>;
  formatSelectionError(
    input: string,
    resolution: Exclude<RemoteModelResolution, { kind: "exact" }>,
    catalog: RemoteModelCatalog,
  ): string;
}

export function createRemoteModelPresentation(
  options: RemotePresentationOptions,
): RemoteModelPresentation {
  const {
    label,
    getCatalog,
    maxCallbackIdLength,
    allowCallbackSeparators,
    quickPickLimit,
    groupThreshold = 60,
  } = options;

  function isCallbackSafeModelID(modelID: string): boolean {
    if (modelID.length > maxCallbackIdLength) return false;
    if (allowCallbackSeparators) return true;
    return !modelID.includes(":") && !modelID.includes("/");
  }

  function getQuickPickModels(
    catalog: RemoteModelCatalog,
    currentModelID?: string,
  ): Array<RemoteModelCatalogEntry> {
    const picks: Array<RemoteModelCatalogEntry> = [];
    const seen = new Set<string>();

    const tryAdd = (model: RemoteModelCatalogEntry | undefined) => {
      if (!model || seen.has(model.id) || !isCallbackSafeModelID(model.id))
        return;
      picks.push(model);
      seen.add(model.id);
    };

    if (currentModelID) {
      const currentModel = resolveRemoteModelInput(currentModelID, catalog);
      if (currentModel.kind === "exact") {
        tryAdd(currentModel.model);
      } else if (currentModel.kind === "ambiguous") {
        tryAdd(currentModel.matches[0]);
      }
    }

    for (const model of catalog.connectedFreeModels) {
      if (picks.length >= quickPickLimit) break;
      tryAdd(model);
    }

    if (picks.length < quickPickLimit) {
      for (const model of catalog.connectedModels) {
        if (picks.length >= quickPickLimit) break;
        tryAdd(model);
      }
    }

    return picks;
  }

  async function getSettingsPresentation(
    activeModel: string,
    options: RemotePickerOptions = {},
  ): Promise<RemotePickerResult> {
    const callbackPrefix = options.callbackPrefix ?? "settings:model:";
    const navPrefix = options.navCallbackPrefix ?? "settings:models";
    const catalog = await getCatalog();
    const current = getRemoteModelInfo(catalog, activeModel);

    const filter = options.filter === "free" ? "free" : "all";
    const selectable = catalog.connectedModels.filter((m) =>
      isCallbackSafeModelID(m.id),
    );
    const freeCount = selectable.filter((m) => m.free).length;
    const scoped = selectable.filter(
      (m) =>
        (filter === "all" || m.free) &&
        (!options.provider || m.providerID === options.provider),
    );

    // A remote catalog can run to hundreds of models, and only the first
    // page's worth ever fit on screen — so offer the provider list as the
    // way in when nothing narrower was asked for and the flat list would be
    // unreadable anyway.
    const providers = catalog.connectedProviders;
    const asGroups =
      !options.provider &&
      providers.length > 1 &&
      scoped.length > groupThreshold;

    const pageSize = Math.max(1, options.pageSize ?? quickPickLimit);
    const source = asGroups ? providers : scoped;
    const totalPages = Math.max(1, Math.ceil(source.length / pageSize));
    const page = Math.min(Math.max(1, options.page ?? 1), totalPages);
    const slice = source.slice((page - 1) * pageSize, page * pageSize);

    const modelButtons: Array<ModelButton> = asGroups
      ? (slice as typeof providers).map((p) => ({
          text: `${p.name} (${p.modelCount})`,
          callback_data: `${navPrefix}:provider:${p.id}`,
        }))
      : (slice as typeof scoped).map((m) => {
          const btnLabel =
            m.id.length <= 20 ? m.id : m.name.length <= 20 ? m.name : m.id;
          const txt = m.free ? `${btnLabel} ★` : btnLabel;
          const sel =
            current &&
            m.id === current.id &&
            m.providerID === current.providerID;
          return {
            text: sel ? `✓ ${txt}` : txt,
            callback_data: `${callbackPrefix}${m.id}`,
          };
        });
    if (!asGroups) {
      modelButtons.push({
        text: "Reset",
        callback_data: `${callbackPrefix}reset`,
      });
    }

    const details: Array<string> = [];
    if (current) {
      details.push(
        `Provider: ${current.providerName} · ${getAvailabilityLabel(current)}`,
      );
      details.push(
        `Context: ${formatCtxWindow(current.contextWindow)} · reasoning ${current.reasoning ? "yes" : "no"} · tools ${current.toolcall ? "yes" : "no"}`,
      );
    }
    const np = catalog.connectedProviders.length;
    const nm = catalog.connectedModels.length;
    details.push(
      `${label}: ${np} provider${np === 1 ? "" : "s"} connected · ${nm} model${nm === 1 ? "" : "s"} usable`,
    );
    if (catalog.loginProviders.length > 0) {
      const preview = catalog.loginProviders
        .slice(0, 4)
        .map((p) => p.name)
        .join(", ");
      details.push(
        `Login available: ${preview}${catalog.loginProviders.length > 4 ? "…" : ""}`,
      );
    }
    details.push("Hint: use /model <name> to switch.");
    return {
      modelButtons,
      modelDetails: details,
      view: asGroups ? "groups" : "models",
      page,
      totalPages,
      filter,
      freeCount,
      totalCount: selectable.length,
      ...(options.provider ? { provider: options.provider } : {}),
    };
  }

  async function renderModelSummary(
    activeModel: string,
    defaultModel: string,
  ): Promise<{ text: string; quickButtons: Array<ModelButton> }> {
    const { modelButtons, modelDetails } =
      await getSettingsPresentation(activeModel);
    const catalog = await getCatalog();
    const current = getRemoteModelInfo(catalog, activeModel);
    const currentLabel = current
      ? getRemoteModelSelectionValue(current, catalog)
      : activeModel;
    const freePreview = catalog.connectedFreeModels.slice(0, 8);

    const lines = [
      `Model: ${currentLabel}${activeModel === defaultModel ? " (default)" : ""}`,
      ...modelDetails,
    ];
    if (freePreview.length > 0) {
      lines.push("", "Free now");
      for (const m of freePreview) {
        const tags = [
          m.providerName,
          m.free ? "free" : `$${m.costInput}/${m.costOutput}`,
          `${formatCtxWindow(m.contextWindow)} ctx`,
          getAvailabilityLabel(m),
        ];
        lines.push(
          `• ${getRemoteModelSelectionValue(m, catalog)} — ${m.name} (${tags.join(" · ")})`,
        );
      }
    }
    return { text: lines.join("\n"), quickButtons: modelButtons };
  }

  async function renderModelList(
    mode: "free" | "all" | "providers",
  ): Promise<string> {
    const catalog = await getCatalog();
    if (mode === "providers") {
      const lines = [`${label} Providers`];
      for (const p of catalog.providers.slice(0, 24)) {
        const detail = p.connected
          ? "connected"
          : p.loginRequired
            ? `login: ${p.authMethods.join(", ")}`
            : p.envRequired
              ? `env: ${p.envKeys.join(", ")}`
              : p.source;
        lines.push(
          `• ${p.name} (${p.id}) — ${detail} · ${p.modelCount} models`,
        );
      }
      if (catalog.providers.length > 24)
        lines.push(`…and ${catalog.providers.length - 24} more`);
      return lines.join("\n");
    }
    const source =
      mode === "free" ? catalog.connectedFreeModels : catalog.connectedModels;
    const title =
      mode === "free" ? "Connected Free Models" : "Connected Models";
    const lines = [title];
    for (const m of source.slice(0, 24)) {
      const tags = [
        m.providerName,
        m.free ? "free" : `$${m.costInput}/${m.costOutput}`,
        `${formatCtxWindow(m.contextWindow)} ctx`,
        getAvailabilityLabel(m),
      ];
      lines.push(
        `• ${getRemoteModelSelectionValue(m, catalog)} — ${m.name} (${tags.join(" · ")})`,
      );
    }
    if (source.length > 24) lines.push(`…and ${source.length - 24} more`);
    return lines.join("\n");
  }

  function formatSelectionError(
    input: string,
    resolution: Exclude<RemoteModelResolution, { kind: "exact" }>,
    catalog: RemoteModelCatalog,
  ): string {
    if (resolution.kind === "missing")
      return `No ${label} model matched "${input}".`;
    const preview = resolution.matches
      .slice(0, 6)
      .map((m) => {
        const provider =
          m.providerName === m.providerID
            ? m.providerName
            : `${m.providerName} / ${m.providerID}`;
        return `${getRemoteModelSelectionValue(m, catalog)} — ${provider} (${getAvailabilityLabel(m)})`;
      })
      .join(", ");
    return `Model query "${input}" is ambiguous. Try one of: ${preview}`;
  }

  return {
    getQuickPickModels,
    getSettingsPresentation,
    renderModelSummary,
    renderModelList,
    formatSelectionError,
  };
}
