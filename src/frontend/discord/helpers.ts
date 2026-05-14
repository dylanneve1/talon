/**
 * Shared helpers for Discord commands, callbacks, and the settings panel.
 *
 * Discord-specific quirks vs the Telegram helpers:
 *  - settings panel uses Components (Buttons + Select Menus), not inline keyboard.
 *  - custom_id strings are limited to 100 chars total — keep payload compact.
 *  - chat IDs are Discord snowflakes (strings), not numbers.
 */

import { resolveModel } from "../../core/models.js";
import { DISCORD_MAX_TEXT, DISCORD_SAFE_RESERVE } from "./formatting.js";

const DEFAULT_PULSE_INTERVAL_MS = 5 * 60 * 1000;
/** Per-message length budget for metrics output. */
const DEFAULT_METRICS_MESSAGE_MAX = DISCORD_MAX_TEXT - DISCORD_SAFE_RESERVE;

/** Effort level descriptions shown next to each option in select menus. */
export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  off: "no extra thinking — fastest",
  low: "short reasoning pass",
  medium: "balanced reasoning",
  high: "deeper reasoning, slower",
  max: "most thorough — slowest",
  adaptive: "model decides when to think",
};

type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; p50: number; p95: number; p99: number; avg: number }
  >;
};

/** Parse a duration string like "30m", "2h", "1d", "1h30m", "1d6h" into ms. */
export function parseInterval(input: string): number | null {
  const match = input.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  const days = parseInt(match[1] || "0", 10);
  const hours = parseInt(match[2] || "0", 10);
  const minutes = parseInt(match[3] || "0", 10);
  const ms = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
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

export function formatModelLabel(modelId: string): string {
  return resolveModel(modelId)?.displayName ?? modelId;
}

function truncateMetricLabel(label: string, max = 60): string {
  return label.length <= max ? label : `${label.slice(0, max - 3)}...`;
}

/**
 * Render the metrics report into one or more Discord messages, each ≤ maxLen
 * (default ~1900 chars to leave headroom under the 2000-char limit).
 */
export function renderMetricsMessages(
  metrics: MetricsSnapshot,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
): string[] {
  const firstHeader = "**📊 Metrics**";
  const continuationHeader = "**📊 Metrics (cont.)**";
  const sections: string[][] = [];

  const histKeys = Object.keys(metrics.histograms).sort();
  if (histKeys.length > 0) {
    sections.push([
      "**Latency**",
      ...histKeys.map((key) => {
        const h = metrics.histograms[key];
        return (
          `  \`${truncateMetricLabel(key)}\`  n=${h.count} ` +
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
        `**${prefix}**`,
        ...keys.map((key) => {
          const label = key.includes(".")
            ? key.split(".").slice(1).join(".")
            : key;
          return `  \`${truncateMetricLabel(label)}\`  ${metrics.counters[key]!.toLocaleString()}`;
        }),
      ]);
    }
  }

  if (sections.length === 0) {
    return [`${firstHeader}\n\n_No metrics recorded yet._`];
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
    if (available < 0) return;
    const safeLine =
      line.length <= available
        ? line
        : available >= 4
          ? `${line.slice(0, available - 3)}...`
          : line.slice(0, available);
    current = `${current}\n${safeLine}`;
  };

  for (const section of sections) {
    appendLine("");
    for (const line of section) appendLine(line);
  }
  if (current !== header || chunks.length === 0) chunks.push(current);
  return chunks;
}

/** Settings panel: build the markdown body. */
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
    "**🦅 Settings**",
    "",
    `**Model:** \`${formatModelLabel(model)}\``,
    ...(modelDetails?.length ? modelDetails : []),
    `**Effort:** ${effort}`,
    `**🔔 Pulse:** ${proactive ? "on" : "off"} (every ${intervalStr})`,
  ].join("\n");
}
