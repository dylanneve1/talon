/**
 * Shared helpers used by commands, callbacks, and the settings panel.
 */

import { escapeHtml } from "./formatting.js";
import type { ModelInfo } from "../../core/models.js";
import { getModels, resolveModel, resolveModelId } from "../../core/models.js";
const DEFAULT_PULSE_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_METRICS_MESSAGE_MAX = 3800;

type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; p50: number; p95: number; p99: number; avg: number }
  >;
};

/** Parse a duration string like "30m", "2h", "1h30m" into milliseconds. */
export function parseInterval(input: string): number | null {
  const match = input.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (!match[1] && !match[2])) return null;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const ms = (hours * 60 + minutes) * 60 * 1000;
  return ms > 0 ? ms : null;
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${safeMs}ms`;
  const s = Math.floor(safeMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Resolve a model ID to its backend-registered display name. */
export function formatModelLabel(modelId: string): string {
  return resolveModel(modelId)?.displayName ?? modelId;
}

/** Display name for a known ModelInfo. */
export function formatModelOptionLabel(model: ModelInfo): string {
  return model.displayName;
}

/** Compact display name for a known ModelInfo. */
export function formatCompactModelLabel(model: ModelInfo): string {
  return model.displayName;
}

export function getTelegramModelOptions(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels()) {
    const key = model.displayName.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    options.push(model);
  }

  return options;
}

function truncateMetricLabel(label: string, max = 80): string {
  return label.length <= max ? label : `${label.slice(0, max - 3)}...`;
}

export function renderMetricsMessages(
  metrics: MetricsSnapshot,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
): string[] {
  const firstHeader = "<b>📊 Metrics</b>";
  const continuationHeader = "<b>📊 Metrics (cont.)</b>";
  const sections: string[][] = [];

  const histKeys = Object.keys(metrics.histograms).sort();
  if (histKeys.length > 0) {
    sections.push([
      "<b>Latency</b>",
      ...histKeys.map((key) => {
        const h = metrics.histograms[key];
        return (
          `  <code>${escapeHtml(truncateMetricLabel(key))}</code>  n=${h.count} ` +
          `p50=${formatDuration(h.p50)}  p95=${formatDuration(h.p95)} ` +
          `p99=${formatDuration(h.p99)}  avg=${formatDuration(h.avg)}`
        );
      }),
    ]);
  }

  const counterKeys = Object.keys(metrics.counters).sort();
  if (counterKeys.length > 0) {
    const groups = new Map<string, string[]>();
    for (const key of counterKeys) {
      const prefix = key.includes(".") ? key.split(".")[0]! : "general";
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix)!.push(key);
    }

    for (const prefix of [...groups.keys()].sort()) {
      const keys = groups.get(prefix)!;
      sections.push([
        `<b>${escapeHtml(prefix)}</b>`,
        ...keys.map((key) => {
          const label = key.includes(".")
            ? key.split(".").slice(1).join(".")
            : key;
          return (
            `  <code>${escapeHtml(truncateMetricLabel(label))}</code>  ` +
            `${metrics.counters[key]!.toLocaleString()}`
          );
        }),
      ]);
    }
  }

  if (sections.length === 0) {
    return [`${firstHeader}\n\n<i>No metrics recorded yet.</i>`];
  }

  const chunks: string[] = [];
  let header = firstHeader;
  let current = header;

  const flush = () => {
    chunks.push(current);
    header = continuationHeader;
    current = header;
  };

  const appendLine = (line: string) => {
    if (!line && current === header) return;

    const candidate = `${current}\n${line}`;
    if (candidate.length <= maxLen) {
      current = candidate;
      return;
    }

    if (current !== header) {
      flush();
      if (!line) return;
    }

    const available = maxLen - header.length - 1;
    if (available < 0) return; // header alone already fills maxLen — skip line
    const safeLine =
      line.length <= available
        ? line
        : available >= 4
          ? `${line.slice(0, available - 3)}...`
          : line.slice(0, available); // not enough room for ellipsis — just truncate
    current = `${current}\n${safeLine}`;
  };

  for (const section of sections) {
    appendLine("");
    for (const line of section) appendLine(line);
  }

  if (current !== header || chunks.length === 0) {
    chunks.push(current);
  }

  return chunks;
}

export function renderSettingsText(
  model: string,
  effort: string,
  proactive: boolean,
  pulseIntervalMs?: number,
  modelDetails?: Array<string>,
): string {
  const intervalStr = pulseIntervalMs
    ? formatDuration(pulseIntervalMs)
    : formatDuration(DEFAULT_PULSE_INTERVAL_MS);
  return [
    "<b>\uD83E\uDD85 Settings</b>",
    "",
    `<b>Model:</b> <code>${escapeHtml(formatModelLabel(model))}</code>`,
    ...(modelDetails?.length ? modelDetails.map(escapeHtml) : []),
    `<b>Effort:</b> ${effort}`,
    `<b>Pulse:</b> ${proactive ? "on" : "off"} (every ${intervalStr})`,
  ].join("\n");
}

export function isSelectedModel(
  currentModel: string,
  modelId: string,
): boolean {
  const current = resolveModel(currentModel);
  const candidate = resolveModel(modelId);
  if (current && candidate) {
    return (
      current.displayName.toLowerCase() === candidate.displayName.toLowerCase()
    );
  }
  return resolveModelId(currentModel) === modelId;
}

export type SettingsButton = { text: string; callback_data: string };

/**
 * Optional pager metadata supplied by the backend for the model
 * picker. When present, callers add a filter row (when `freeCount > 0`)
 * and a Prev / page / Next row (when `totalPages > 1`). Backends with
 * small fixed catalogs may omit this entirely.
 */
export interface SettingsPager {
  page: number;
  totalPages: number;
  filter: "all" | "free";
  freeCount: number;
  totalCount: number;
}

/**
 * Build the pager + filter button rows for a model picker. Shared by
 * `/settings` and the standalone `/model` command. `navPrefix` is the
 * callback-data prefix used for filter and pagination buttons —
 * `/settings` uses `settings:models` (so its handler sees
 * `settings:models:page:N:F`), `/model` uses `model:nav` (so its
 * handler sees `model:nav:page:N:F`). A `noopData` sentinel is the
 * callback for disabled-edge buttons (Telegram requires every inline
 * button to carry callback data).
 */
export function renderModelPickerControlRows(
  pager: SettingsPager,
  navPrefix: string,
  noopData: string,
  view: "models" | "groups" = "models",
  activeProvider?: string,
): Array<Array<SettingsButton>> {
  const rows: Array<Array<SettingsButton>> = [];
  // When showing one provider's models, offer an explicit way back to
  // the provider list. Encoded as `…:providers` so the callback
  // handler knows to drop the `provider` option on re-render.
  if (view === "models" && activeProvider) {
    rows.push([
      {
        text: `← Providers`,
        callback_data: `${navPrefix}:providers`,
      },
    ]);
  }
  if (pager.totalPages > 1) {
    const prev = Math.max(1, pager.page - 1);
    const next = Math.min(pager.totalPages, pager.page + 1);
    const providerSuffix = activeProvider ? `:${activeProvider}` : "";
    rows.push([
      {
        text: pager.page > 1 ? "← Prev" : "·",
        callback_data:
          pager.page > 1
            ? `${navPrefix}:page:${prev}:${pager.filter}${providerSuffix}`
            : noopData,
      },
      {
        text: `${pager.page} / ${pager.totalPages}`,
        callback_data: noopData,
      },
      {
        text: pager.page < pager.totalPages ? "Next →" : "·",
        callback_data:
          pager.page < pager.totalPages
            ? `${navPrefix}:page:${next}:${pager.filter}${providerSuffix}`
            : noopData,
      },
    ]);
  }
  return rows;
}

// ── /model main-menu + browse view ──────────────────────────────────────────
//
// /model has two screens:
//
//   1. Main menu (`model:menu` callback path) — shows current model +
//      toggles. Free-only toggle persists into chat-settings, so the
//      preference survives bot restarts. "Browse models" drills into
//      screen 2.
//   2. Browse (`model:nav:*` callback path) — provider chips → models
//      with pagination and a "← Back to menu" return button.
//
// All Telegram inline buttons here use callback data ≤ 64 bytes as
// required by https://core.telegram.org/bots/api#inlinekeyboardbutton.

export interface ModelMenuState {
  activeModel: string;
  /** Human-readable active model name (display) */
  activeDisplay: string;
  /** Active model status line(s) shown above the buttons. */
  statusLines: string[];
  /** Whether this chat has a per-chat model override (vs falling back to config default). */
  hasOverride: boolean;
  /** Whether the backend reports any free-tier models — controls visibility of the Free toggle. */
  showFreeToggle: boolean;
  /** Current persisted free-only setting for this chat. */
  freeOnly: boolean;
  /**
   * Backend currently serving this chat (override → role default).
   * `id` is the registry slug; `label` is the display name.
   */
  activeBackend: { id: string; label: string };
  /** True when this chat has a per-chat backend override. */
  hasBackendOverride: boolean;
  /**
   * Whether the picker should offer a "Change backend" button. False
   * when `enabledBackends` limits the menu to a single backend.
   */
  showBackendButton: boolean;
}

/** Inputs needed to build a `ModelMenuState`. Pure-function shape so tests can stub everything. */
export interface BuildModelMenuStateArgs {
  chatId: string;
  activeModel: string;
  defaultModel: string;
  freeOnly: boolean;
  /**
   * Backend hook to fetch a passive snapshot of the catalog. We only
   * read `freeCount`, `totalCount`, and `modelDetails` for the body
   * status line — never render `modelButtons` from this call.
   */
  fetchSnapshot: () => Promise<{
    freeCount: number;
    totalCount: number;
    modelDetails: string[];
  }>;
  /** Resolve display name for the active model. Falls back to the raw id. */
  fetchActiveDisplay: () => Promise<string | undefined>;
  /** Backend currently serving this chat — id and human label. */
  activeBackend: { id: string; label: string };
  /** Whether this chat has a per-chat backend override pinned in the pool. */
  hasBackendOverride: boolean;
  /**
   * Whether more than one backend is offered to the user. Drives the
   * "Change backend" button — hide it when there's nothing to switch to.
   */
  showBackendButton: boolean;
}

export async function buildModelMenuState(
  args: BuildModelMenuStateArgs,
): Promise<ModelMenuState> {
  const [snapshot, display] = await Promise.all([
    args.fetchSnapshot().catch(() => ({
      freeCount: 0,
      totalCount: 0,
      modelDetails: [],
    })),
    args.fetchActiveDisplay().catch(() => undefined),
  ]);

  return {
    activeModel: args.activeModel,
    activeDisplay: display ?? args.activeModel,
    statusLines: snapshot.modelDetails.slice(),
    hasOverride: args.activeModel !== args.defaultModel,
    showFreeToggle: snapshot.freeCount > 0,
    freeOnly: args.freeOnly,
    activeBackend: args.activeBackend,
    hasBackendOverride: args.hasBackendOverride,
    showBackendButton: args.showBackendButton,
  };
}

/** Build the main-menu inline keyboard for `/model`. */
export function renderModelMenuKeyboard(
  state: ModelMenuState,
): Array<Array<SettingsButton>> {
  const rows: Array<Array<SettingsButton>> = [];

  rows.push([{ text: "Browse models", callback_data: "model:browse" }]);

  if (state.showBackendButton) {
    rows.push([
      {
        text: `Backend: ${state.activeBackend.label}`,
        callback_data: "model:backends",
      },
    ]);
  }

  if (state.showFreeToggle) {
    rows.push([
      {
        text: state.freeOnly ? "Free only: ON" : "Free only: OFF",
        callback_data: "model:toggle-free",
      },
    ]);
  }

  if (state.hasOverride) {
    rows.push([{ text: "Reset to default", callback_data: "model:reset" }]);
  }

  return rows;
}

/**
 * Build the backend-submenu keyboard. Reached via the "Backend" button
 * on the main `/model` menu; each row is a candidate backend the chat
 * can switch to (plus a "Use default" row when overridden, and a
 * "Back" row).
 */
export function renderBackendMenuKeyboard(opts: {
  available: Array<{ id: string; label: string }>;
  activeBackendId: string;
  hasBackendOverride: boolean;
}): Array<Array<SettingsButton>> {
  const rows: Array<Array<SettingsButton>> = [];
  for (const b of opts.available) {
    const active = b.id === opts.activeBackendId;
    rows.push([
      {
        text: active ? `✅ ${b.label} (active)` : b.label,
        callback_data: active ? "model:noop" : `model:backend:${b.id}`,
      },
    ]);
  }
  if (opts.hasBackendOverride) {
    rows.push([
      {
        text: "Reset to default backend",
        callback_data: "model:backend-default",
      },
    ]);
  }
  rows.push([{ text: "← Back to /model", callback_data: "model:menu" }]);
  return rows;
}

/** Body text for the backend submenu. */
export function renderBackendMenuText(opts: {
  activeBackend: { id: string; label: string };
  hasBackendOverride: boolean;
  defaultBackendLabel: string;
}): string {
  const lines = [
    `<b>Backend</b>`,
    `Active: <b>${opts.activeBackend.label}</b> (<code>${opts.activeBackend.id}</code>)`,
  ];
  if (opts.hasBackendOverride) {
    lines.push(
      `<i>Per-chat override — default is <b>${opts.defaultBackendLabel}</b>.</i>`,
    );
  } else {
    lines.push(`<i>Using the global default.</i>`);
  }
  lines.push(
    "",
    "Switching the backend resets this chat's session — model choice will fall back to the new backend's default.",
  );
  return lines.join("\n");
}

/** Format the body text of the `/model` main menu. */
export function renderModelMenuText(state: ModelMenuState): string {
  const lines: string[] = [
    `<b>Model:</b> <code>${state.activeDisplay}</code>`,
    ...state.statusLines.map((l) => l),
  ];
  if (state.freeOnly && state.showFreeToggle) {
    lines.push("<i>Filtering to free-tier models when browsing.</i>");
  }
  return lines.join("\n");
}

/**
 * Build the inline keyboard for the /model "browse" screen (provider
 * groups OR a paginated model list). `backToMenuData` is the callback
 * sent when the user wants to return to the main menu.
 */
export function renderModelBrowseKeyboard(
  modelButtons: Array<SettingsButton>,
  pager: SettingsPager,
  view: "models" | "groups",
  activeProvider: string | undefined,
  backToMenuData: string,
): Array<Array<SettingsButton>> {
  const cols = 2;
  const modelRows: Array<Array<SettingsButton>> = [];
  for (let i = 0; i < modelButtons.length; i += cols) {
    modelRows.push(modelButtons.slice(i, i + cols));
  }
  const controlRows = renderModelPickerControlRows(
    pager,
    "model:nav",
    "model:noop",
    view,
    activeProvider,
  );
  return [
    ...modelRows,
    ...controlRows,
    [{ text: "← Back to menu", callback_data: backToMenuData }],
  ];
}

export function renderSettingsKeyboard(
  model: string,
  effort: string,
  proactive: boolean,
  modelButtons?: Array<SettingsButton>,
  pager?: SettingsPager,
  view: "models" | "groups" = "models",
  activeProvider?: string,
): Array<Array<SettingsButton>> {
  const selectedButtons = modelButtons?.length
    ? modelButtons
    : getTelegramModelOptions().map((m) => ({
        text: isSelectedModel(model, m.id)
          ? `\u2713 ${formatCompactModelLabel(m)}`
          : formatCompactModelLabel(m),
        callback_data: `settings:model:${m.id}`,
      }));
  const cols = modelButtons?.length ? 2 : 3;
  const modelRows: Array<Array<SettingsButton>> = [];
  for (let i = 0; i < selectedButtons.length; i += cols) {
    modelRows.push(selectedButtons.slice(i, i + cols));
  }

  const controlRows = pager
    ? renderModelPickerControlRows(
        pager,
        "settings:models",
        "settings:noop",
        view,
        activeProvider,
      )
    : [];

  return [
    ...modelRows,
    ...controlRows,
    [
      {
        text: effort === "low" ? "\u2713 Low" : "Low",
        callback_data: "settings:effort:low",
      },
      {
        text: effort === "medium" ? "\u2713 Med" : "Med",
        callback_data: "settings:effort:medium",
      },
      {
        text: effort === "high" ? "\u2713 High" : "High",
        callback_data: "settings:effort:high",
      },
      {
        text: effort === "adaptive" ? "\u2713 Auto" : "Auto",
        callback_data: "settings:effort:adaptive",
      },
    ],
    [
      {
        text: proactive ? "Pulse: ON" : "Pulse: OFF",
        callback_data: `settings:proactive:${proactive ? "off" : "on"}`,
      },
    ],
  ];
}
