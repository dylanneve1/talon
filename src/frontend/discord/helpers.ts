/**
 * Shared helpers for Discord commands, callbacks, and the settings panel.
 *
 * Discord-specific quirks vs the Telegram helpers:
 *  - settings panel uses Components (Buttons + Select Menus), not inline keyboard.
 *  - custom_id strings are limited to 100 chars total — keep payload compact.
 *  - chat IDs are Discord snowflakes (strings), not numbers.
 */

import { REASONING_LEVEL_DESCRIPTIONS } from "../../core/models/reasoning-levels.js";
import {
  DISCORD_MAX_TEXT,
  DISCORD_SAFE_RESERVE,
  splitMessage,
} from "./formatting.js";
import type { DoctorReport } from "../../core/doctor.js";
import type { MeshPingResult } from "../../core/mesh/service.js";
import type { BackendUsageEntry } from "../shared/plan-usage-report.js";
import {
  DEFAULT_PULSE_INTERVAL_MS,
  formatDuration,
  formatBytes,
  formatModelLabel,
} from "../shared/format.js";

export {
  parseInterval,
  formatDuration,
  formatTokenCount,
  formatBytes,
  formatUsd,
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
    { count: number; avg: number; min: number; max: number }
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
  title = "📊 Metrics",
): string[] {
  const firstHeader = `**${title}**`;
  const continuationHeader = `**${title} (cont.)**`;
  const sections: string[][] = [];

  // Histograms come in two flavours: durations (keys ending in `_ms`,
  // rendered as human times) and plain counts like `tool_calls_per_turn`
  // (rendered as bare numbers — "min=1ms" for a count is nonsense).
  const histKeys = Object.keys(metrics.histograms).sort();
  const durationKeys = histKeys.filter((key) => key.endsWith("_ms"));
  const countKeys = histKeys.filter((key) => !key.endsWith("_ms"));
  const histLine = (key: string, fmt: (v: number) => string): string => {
    const h = metrics.histograms[key];
    return (
      `  \`${truncateMetricLabel(key)}\`  n=${h.count} ` +
      `avg=${fmt(h.avg)}  min=${fmt(h.min)} ` +
      `max=${fmt(h.max)}`
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

const DOCTOR_ICONS: Record<string, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
  info: "▫️",
};

/**
 * Render a DoctorReport as Discord markdown, split to fit the message cap.
 * Same data as `talon doctor` and Telegram's /doctor.
 */
export function renderDoctorMessages(
  report: DoctorReport,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
): string[] {
  const lines = ["**🩺 Talon Doctor**", "", "**Environment**"];

  const render = (check: DoctorReport["checks"][number]): string =>
    `${DOCTOR_ICONS[check.status]} ${check.label}${check.detail ? ` (${check.detail})` : ""}`;

  for (const check of report.checks.filter((c) => !c.inactive)) {
    lines.push(render(check));
  }

  // Configured-but-idle backends get their own block: they describe what a
  // switch would run into, not the state of the running deployment.
  const idle = report.checks.filter((c) => c.inactive);
  if (idle.length > 0) {
    lines.push("", "**Other backends**", ...idle.map(render));
  }

  lines.push("", "**Native modules**");
  for (const mod of report.native) {
    const size =
      mod.sizeBytes !== undefined ? ` · ${formatBytes(mod.sizeBytes)}` : "";
    const note = mod.note ? ` (${mod.note})` : "";
    lines.push(
      `${mod.ok ? DOCTOR_ICONS.ok : DOCTOR_ICONS.fail} \`${mod.name}\` — ${mod.language} → ${mod.target}${size}${note}`,
    );
  }

  lines.push(
    "",
    "**Process**",
    `Uptime ${formatDuration(process.uptime() * 1000)} · PID ${process.pid} · Node ${process.versions.node}`,
    "",
    report.issues === 0
      ? `${DOCTOR_ICONS.ok} All checks passed.`
      : `${DOCTOR_ICONS.warn} ${report.issues} issue(s) found.`,
  );

  return splitMessage(lines.join("\n"), maxLen);
}

function meshDeviceLine(r: MeshPingResult, now: number): string {
  const d = r.device;
  const bits: string[] = [d.platform];
  if (r.reachable && typeof r.latencyMs === "number") {
    bits.push(`${r.latencyMs} ms`);
  } else if (d.online && r.error) {
    bits.push(r.error);
  } else if (!d.online) {
    bits.push(`last seen ${formatDuration(now - d.lastSeen)} ago`);
  }
  if (typeof d.battery === "number") {
    bits.push(`${d.battery}%${d.charging ? " charging" : ""}`);
  }
  return `  **${d.name}** — ${bits.join(" · ")}`;
}

/**
 * Render the /mesh fleet report as Discord markdown. Devices group under a
 * state heading; empty groups are omitted.
 */
export function renderMeshReport(
  results: MeshPingResult[],
  now = Date.now(),
): string {
  if (results.length === 0) {
    return "**Mesh**\n\n_No devices have registered yet._";
  }

  const responding = results
    .filter((r) => r.reachable)
    .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity));
  const unreachable = results
    .filter((r) => !r.reachable && r.device.online)
    .sort((a, b) => a.device.name.localeCompare(b.device.name));
  const offline = results
    .filter((r) => !r.reachable && !r.device.online)
    .sort((a, b) => b.device.lastSeen - a.device.lastSeen);

  const summary = [
    `${results.length} device${results.length === 1 ? "" : "s"}`,
    `${responding.length} responding`,
    ...(unreachable.length > 0 ? [`${unreachable.length} unreachable`] : []),
    ...(offline.length > 0 ? [`${offline.length} offline`] : []),
  ].join(" · ");

  const lines = ["**Mesh**", summary];
  const section = (title: string, entries: MeshPingResult[]): void => {
    if (entries.length === 0) return;
    lines.push(
      "",
      `**${title}**`,
      ...entries.map((r) => meshDeviceLine(r, now)),
    );
  };
  section("Responding", responding);
  section("Unreachable", unreachable);
  section("Offline", offline);

  return lines.join("\n");
}

/** Render the `/usage` report — one block per exposed backend. */
export function renderUsageMessage(entries: BackendUsageEntry[]): string {
  const lines = ["**📊 Plan usage**"];

  for (const entry of entries) {
    const name = entry.label || entry.id;
    if (!entry.plan) {
      lines.push("", `**${name}** — _${entry.note ?? ""}_`);
      continue;
    }
    const age = entry.plan.ageLabel ? ` *(${entry.plan.ageLabel})*` : "";
    const plan = entry.plan.plan ? ` · ${entry.plan.plan}` : "";
    lines.push("", `**${name}**${plan}${age}`);
    for (const w of entry.plan.windows) {
      const reset = w.resetLabel ? ` reset ${w.resetLabel}` : "";
      lines.push(
        `  \`${w.label.padEnd(6)}${w.bar} ${String(w.percent).padStart(3)}%\`${reset}`,
      );
    }
  }

  return lines.join("\n");
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
