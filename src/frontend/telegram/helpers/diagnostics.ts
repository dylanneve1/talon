/**
 * Metrics + doctor report rendering for Telegram (HTML messages).
 */

import { escapeHtml } from "../formatting.js";
import type { DoctorReport } from "../../../core/doctor.js";
import { formatDuration, formatBytes } from "./format.js";

const DEFAULT_METRICS_MESSAGE_MAX = 3800;

type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; avg: number; min: number; max: number }
  >;
};

function truncateMetricLabel(label: string, max = 80): string {
  return label.length <= max ? label : `${label.slice(0, max - 3)}...`;
}

export function renderMetricsMessages(
  metrics: MetricsSnapshot,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
  title = "📊 Metrics",
): string[] {
  const firstHeader = `<b>${escapeHtml(title)}</b>`;
  const continuationHeader = `<b>${escapeHtml(title)} (cont.)</b>`;
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
      `  <code>${escapeHtml(truncateMetricLabel(key))}</code>  n=${h.count} ` +
      `avg=${fmt(h.avg)}  min=${fmt(h.min)} ` +
      `max=${fmt(h.max)}`
    );
  };
  if (durationKeys.length > 0) {
    sections.push([
      "<b>Latency</b>",
      ...durationKeys.map((key) => histLine(key, formatDuration)),
    ]);
  }
  if (countKeys.length > 0) {
    sections.push([
      "<b>Distributions</b>",
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

const DOCTOR_ICONS: Record<string, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
  info: "▫️",
};

/**
 * Render a DoctorReport as one Telegram HTML message. Same data as
 * `talon doctor` (src/core/doctor.ts) plus in-process runtime info —
 * when this renders, the bot is by definition running, so the CLI's
 * "is the bot up" probe becomes an uptime line instead.
 */
export function renderDoctorMessage(report: DoctorReport): string {
  const lines = ["<b>🩺 Talon Doctor</b>", "", "<b>Environment</b>"];

  for (const check of report.checks) {
    const detail = check.detail ? ` (${escapeHtml(check.detail)})` : "";
    lines.push(
      `${DOCTOR_ICONS[check.status]} ${escapeHtml(check.label)}${detail}`,
    );
  }

  lines.push("", "<b>Native modules</b>");
  for (const mod of report.native) {
    const size =
      mod.sizeBytes !== undefined ? ` · ${formatBytes(mod.sizeBytes)}` : "";
    const note = mod.note ? ` (${escapeHtml(mod.note)})` : "";
    lines.push(
      `${mod.ok ? DOCTOR_ICONS.ok : DOCTOR_ICONS.fail} <code>${escapeHtml(mod.name)}</code> — ${escapeHtml(mod.language)} → ${escapeHtml(mod.target)}${size}${note}`,
    );
  }

  lines.push(
    "",
    "<b>Process</b>",
    `Uptime ${formatDuration(process.uptime() * 1000)} · PID ${process.pid} · Node ${escapeHtml(process.versions.node)}`,
    "",
    report.issues === 0
      ? `${DOCTOR_ICONS.ok} All checks passed.`
      : `${DOCTOR_ICONS.warn} ${report.issues} issue(s) found.`,
  );

  return lines.join("\n");
}
