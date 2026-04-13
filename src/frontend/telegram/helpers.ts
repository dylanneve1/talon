/**
 * Shared helpers used by commands, callbacks, and the settings panel.
 */

import { escapeHtml } from "./formatting.js";
import { getModels } from "../../core/models.js";
const DEFAULT_PULSE_INTERVAL_MS = 5 * 60 * 1000;

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
  const s = Math.floor(ms / 1000);
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

export function renderSettingsText(
  model: string,
  effort: string,
  proactive: boolean,
  pulseIntervalMs?: number,
): string {
  const intervalStr = pulseIntervalMs
    ? formatDuration(pulseIntervalMs)
    : formatDuration(DEFAULT_PULSE_INTERVAL_MS);
  return [
    "<b>\uD83E\uDD85 Settings</b>",
    "",
    `<b>Model:</b> <code>${escapeHtml(model)}</code>`,
    `<b>Effort:</b> ${effort}`,
    `<b>Pulse:</b> ${proactive ? "on" : "off"} (every ${intervalStr})`,
  ].join("\n");
}

export function renderSettingsKeyboard(
  model: string,
  effort: string,
  proactive: boolean,
): Array<Array<{ text: string; callback_data: string }>> {
  // Build model row dynamically from the registry
  const modelRow = getModels().map((m) => ({
    text: model.includes(m.id)
      ? `\u2713 ${m.displayName.split(" ")[0]}`
      : m.displayName.split(" ")[0],
    callback_data: `settings:model:${m.aliases[0] ?? m.id}`,
  }));
  return [
    modelRow,
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
