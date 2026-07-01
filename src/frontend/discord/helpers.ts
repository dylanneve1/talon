/**
 * Shared helpers for Discord commands, callbacks, and the settings panel.
 *
 * Discord-specific quirks vs the Telegram helpers:
 *  - settings panel uses Components (Buttons + Select Menus), not inline keyboard.
 *  - custom_id strings are limited to 100 chars total — keep payload compact.
 *  - chat IDs are Discord snowflakes (strings), not numbers.
 */

import { REASONING_LEVEL_DESCRIPTIONS } from "../../core/models/reasoning-levels.js";
import { DISCORD_MAX_TEXT, DISCORD_SAFE_RESERVE } from "./formatting.js";
import {
  DEFAULT_PULSE_INTERVAL_MS,
  formatDuration,
  formatModelLabel,
} from "../shared/format.js";

export {
  parseInterval,
  formatDuration,
  formatTokenCount,
  formatBytes,
  formatModelLabel,
} from "../shared/format.js";

/** Per-message length budget for metrics output. */
const DEFAULT_METRICS_MESSAGE_MAX = DISCORD_MAX_TEXT - DISCORD_SAFE_RESERVE;

/** Effort level descriptions shown next to each option in select menus. */
export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  ...REASONING_LEVEL_DESCRIPTIONS,
};

type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; p50: number; p95: number; p99: number; avg: number }
  >;
};

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

  // Histograms come in two flavours: durations (keys ending in `_ms`,
  // rendered as human times) and plain counts like `tool_calls_per_turn`
  // (rendered as bare numbers — "p50=1ms" for a count is nonsense).
  const histKeys = Object.keys(metrics.histograms).sort();
  const durationKeys = histKeys.filter((key) => key.endsWith("_ms"));
  const countKeys = histKeys.filter((key) => !key.endsWith("_ms"));
  const histLine = (key: string, fmt: (v: number) => string): string => {
    const h = metrics.histograms[key];
    return (
      `  \`${truncateMetricLabel(key)}\`  n=${h.count} ` +
      `p50=${fmt(h.p50)}  p95=${fmt(h.p95)} ` +
      `p99=${fmt(h.p99)}  avg=${fmt(h.avg)}`
    );
  };
  if (durationKeys.length > 0) {
    sections.push([
      "**Latency**",
      ...durationKeys.map((key) => histLine(key, formatDuration)),
    ]);
  }
  if (countKeys.length > 0) {
    sections.push([
      "**Distributions**",
      ...countKeys.map((key) => histLine(key, String)),
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
      // tool_calls reads best as a leaderboard — busiest tools first.
      // Other groups keep alphabetical order (stable lookup by name).
      const keys =
        prefix === "tool_calls"
          ? [...groups.get(prefix)!].sort(
              (a, b) =>
                metrics.counters[b]! - metrics.counters[a]! ||
                a.localeCompare(b),
            )
          : groups.get(prefix)!;
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
