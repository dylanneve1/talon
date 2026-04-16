/**
 * Shared helpers used by commands, callbacks, and the settings panel.
 */

import { escapeHtml } from "./formatting.js";
import type { ModelInfo } from "../../core/models.js";
import { getModels, resolveModel, resolveModelId } from "../../core/models.js";
const DEFAULT_PULSE_INTERVAL_MS = 5 * 60 * 1000;
const FAMILY_VERSION_PATTERN = /\b([A-Za-z][A-Za-z-]*)\s+(\d+(?:\.\d+)*)\b/;
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

function toDisplayFamilyName(family: string): string {
  return family
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatResolvedModelLabel(model: ModelInfo): string {
  const match = `${model.displayName} ${model.description ?? ""}`.match(
    FAMILY_VERSION_PATTERN,
  );
  if (match) {
    return `${toDisplayFamilyName(match[1])} ${match[2]}`;
  }

  const familyAlias = model.aliases.find(
    (alias) =>
      !alias.startsWith("claude-") &&
      !alias.endsWith("[1m]") &&
      !/[-.]\d/.test(alias),
  );
  const baseName = familyAlias
    ? toDisplayFamilyName(familyAlias)
    : model.displayName.replace(/\s*\([^)]*\)/g, "").trim();
  return baseName;
}

export function formatModelLabel(modelId: string): string {
  const model = resolveModel(modelId);
  return model ? formatResolvedModelLabel(model) : modelId;
}

export function formatModelOptionLabel(model: ModelInfo): string {
  return formatResolvedModelLabel(model);
}

export function formatCompactModelLabel(model: ModelInfo): string {
  return formatResolvedModelLabel(model);
}

export function getTelegramModelOptions(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels()) {
    const key = formatResolvedModelLabel(model).toLowerCase();
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
    ...(modelDetails?.length ? modelDetails : []),
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
      formatResolvedModelLabel(current).toLowerCase() ===
      formatResolvedModelLabel(candidate).toLowerCase()
    );
  }
  return resolveModelId(currentModel) === modelId;
}

export type SettingsButton = { text: string; callback_data: string };

export function renderSettingsKeyboard(
  model: string,
  effort: string,
  proactive: boolean,
  modelButtons?: Array<SettingsButton>,
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
  return [
    ...modelRows,
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
      { text: "Done", callback_data: "settings:done" },
    ],
  ];
}
