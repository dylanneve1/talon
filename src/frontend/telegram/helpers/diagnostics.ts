/**
 * Metrics, doctor, and mesh report rendering for Telegram (HTML messages).
 */

import { escapeHtml } from "../formatting.js";
import type { DoctorReport } from "../../../core/doctor.js";
import type { MeshPingResult } from "../../../core/mesh/service.js";
import type { SettingsButton } from "./menu.js";
import { formatDuration, formatBytes } from "./format.js";

const DEFAULT_METRICS_MESSAGE_MAX = 3800;

/**
 * Rows shown in the `tool_calls` leaderboard before the tail collapses
 * into a "…and N more" line. A long-lived bot accumulates a lifetime
 * tool-call entry per distinct tool name (easily 100+ once plugin and
 * MCP tools are counted), which is what used to push /metrics past
 * Telegram's message limit and split it across messages.
 */
const TOOL_CALLS_TOP_N = 12;

type MetricsSnapshot = {
  counters: Record<string, number>;
  histograms: Record<
    string,
    { count: number; avg: number; min: number; max: number }
  >;
};

/** Which grain the /metrics panel is currently showing. */
export type MetricsView = "today" | "all";

const VIEW_TITLES: Record<MetricsView, string> = {
  today: "Metrics — today (UTC)",
  all: "Metrics — all time",
};

/**
 * One titled block of the panel. `hidden` counts rows dropped to make
 * the panel fit one message; it renders as a trailing "…and N more".
 */
type Section = { title: string; rows: string[]; hidden: number };

function truncateMetricLabel(label: string, max = 80): string {
  return label.length <= max ? label : `${label.slice(0, max - 3)}...`;
}

function buildMetricsSections(metrics: MetricsSnapshot): Section[] {
  const sections: Section[] = [];

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
    sections.push({
      title: "<b>Latency</b>",
      rows: durationKeys.map((key) => histLine(key, formatDuration)),
      hidden: 0,
    });
  }
  if (countKeys.length > 0) {
    sections.push({
      title: "<b>Distributions</b>",
      rows: countKeys.map((key) => histLine(key, String)),
      hidden: 0,
    });
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
      const isToolCalls = prefix === "tool_calls";
      const keys = isToolCalls
        ? [...groups.get(prefix)!].sort(
            (a, b) =>
              metrics.counters[b]! - metrics.counters[a]! || a.localeCompare(b),
          )
        : groups.get(prefix)!;
      // The leaderboard is pre-capped: past the top N the tail is a long
      // list of one-call tools nobody reads, and on the all-time view it
      // is what made the panel overflow.
      const shown = isToolCalls ? keys.slice(0, TOOL_CALLS_TOP_N) : keys;
      sections.push({
        title: `<b>${escapeHtml(prefix)}</b>`,
        rows: shown.map((key) => {
          const label = key.includes(".")
            ? key.split(".").slice(1).join(".")
            : key;
          return (
            `  <code>${escapeHtml(truncateMetricLabel(label))}</code>  ` +
            `${metrics.counters[key]!.toLocaleString()}`
          );
        }),
        hidden: keys.length - shown.length,
      });
    }
  }

  return sections;
}

function renderSection(section: Section): string {
  const lines = [section.title, ...section.rows];
  if (section.hidden > 0) {
    lines.push(`  <i>…and ${section.hidden} more</i>`);
  }
  return lines.join("\n");
}

/**
 * Render the sections under `header`, shrinking to fit `maxLen`.
 *
 * Telegram hard-caps a message at 4096 characters. Rather than split the
 * report across messages — which is what the panel replaced — rows are
 * dropped from the longest section first (each drop bumping that
 * section's "…and N more") until the whole thing fits. Sections always
 * keep at least their first row, so every group stays visible.
 */
function fitPanel(header: string, sections: Section[], maxLen: number): string {
  const render = () => [header, ...sections.map(renderSection)].join("\n\n");

  let out = render();
  while (out.length > maxLen) {
    let target: Section | undefined;
    for (const section of sections) {
      if (section.rows.length <= 1) continue;
      if (!target || section.rows.length > target.rows.length) target = section;
    }
    if (!target) break;
    target.rows.pop();
    target.hidden += 1;
    out = render();
  }

  if (out.length <= maxLen) return out;
  // Nothing left to shed (a pathologically small maxLen). Cut on a line
  // boundary so we never slice through an HTML tag and fail the parse.
  const cut = out.lastIndexOf("\n", maxLen - 1);
  return cut > 0 ? out.slice(0, cut) : out.slice(0, maxLen);
}

/**
 * Render the /metrics panel for one grain as a SINGLE Telegram message.
 * Pair it with `renderMetricsKeyboard(view)` — the Today / All time
 * buttons swap grains by editing this message in place.
 */
export function renderMetricsPanel(
  metrics: MetricsSnapshot,
  view: MetricsView,
  maxLen = DEFAULT_METRICS_MESSAGE_MAX,
): string {
  const header = `<b>${escapeHtml(VIEW_TITLES[view])}</b>`;
  const sections = buildMetricsSections(metrics);
  if (sections.length === 0) {
    return `${header}\n\n<i>No metrics recorded yet.</i>`;
  }
  return fitPanel(header, sections, maxLen);
}

/** Grain-switch buttons for the /metrics panel. */
export function renderMetricsKeyboard(
  view: MetricsView,
): Array<Array<SettingsButton>> {
  return [
    [
      {
        text: view === "today" ? "✓ Today" : "Today",
        callback_data: "metrics:today",
      },
      {
        text: view === "all" ? "✓ All time" : "All time",
        callback_data: "metrics:all",
      },
    ],
  ];
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

// ── /mesh ───────────────────────────────────────────────────────────────────

function meshDeviceLine(r: MeshPingResult, now: number): string {
  const d = r.device;
  const bits: string[] = [escapeHtml(d.platform)];
  if (r.reachable && typeof r.latencyMs === "number") {
    bits.push(`${r.latencyMs} ms`);
  } else if (d.online && r.error) {
    bits.push(escapeHtml(r.error));
  } else if (!d.online) {
    bits.push(`last seen ${formatDuration(now - d.lastSeen)} ago`);
  }
  if (typeof d.battery === "number") {
    bits.push(`${d.battery}%${d.charging ? " charging" : ""}`);
  }
  return `  <b>${escapeHtml(d.name)}</b> — ${bits.join(" · ")}`;
}

/**
 * Render the `/mesh` fleet report as one HTML message.
 *
 * Devices group under a state heading — Responding, Unreachable, Offline
 * — rather than carrying a coloured status glyph per row: the grouping
 * already says what the glyph said, and the report stays readable when
 * the fleet grows. Empty groups are omitted entirely.
 */
export function renderMeshReport(
  results: MeshPingResult[],
  now = Date.now(),
): string {
  if (results.length === 0) {
    return "<b>Mesh</b>\n\n<i>No devices have registered yet.</i>";
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

  const lines = ["<b>Mesh</b>", summary];
  const section = (title: string, entries: MeshPingResult[]): void => {
    if (entries.length === 0) return;
    lines.push(
      "",
      `<b>${title}</b>`,
      ...entries.map((r) => meshDeviceLine(r, now)),
    );
  };
  section("Responding", responding);
  section("Unreachable", unreachable);
  section("Offline", offline);

  return lines.join("\n");
}
