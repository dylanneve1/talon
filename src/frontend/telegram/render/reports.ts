/**
 * Metrics, doctor, mesh and usage reports for Telegram (HTML messages).
 *
 * The reports themselves live in `frontend/presentation/reports.ts` and
 * the HTML dialect in `./html.ts`; this file is the wrappers that keep
 * each command to a single import, plus the two Telegram-only pieces:
 * the /metrics grain keyboard and the `/mesh` bridge footer.
 */

import { escapeHtml } from "../formatting.js";
import type { DoctorReport } from "../../../core/doctor/index.js";
import type { MeshPingResult } from "../../../core/mesh/devices/service.js";
import type { BackendUsageEntry } from "../../presentation/plan-usage-report.js";
import type { SettingsButton } from "./menu.js";
import {
  renderDoctorReport,
  renderMeshReport as renderMeshReportWith,
  renderMetricsPanel as renderMetricsPanelWith,
  renderUsageMessage as renderUsageMessageWith,
  type MetricsSnapshot,
} from "../../presentation/reports.js";
import { TELEGRAM_MESSAGE_MAX, TELEGRAM_REPORTS } from "./html.js";

/**
 * Rows shown in the `tool_calls` leaderboard before the tail collapses
 * into a "…and N more" line. A long-lived bot accumulates a lifetime
 * tool-call entry per distinct tool name (easily 100+ once plugin and
 * MCP tools are counted), which is what used to push /metrics past
 * Telegram's message limit and split it across messages.
 */
const TOOL_CALLS_TOP_N = 12;

/** Which grain the /metrics panel is currently showing. */
export type MetricsView = "today" | "all";

const VIEW_TITLES: Record<MetricsView, string> = {
  today: "Metrics — today (UTC)",
  all: "Metrics — all time",
};

/**
 * Render the /metrics panel for one grain as a SINGLE Telegram message.
 * Pair it with `renderMetricsKeyboard(view)` — the Today / All time
 * buttons swap grains by editing this message in place.
 */
export function renderMetricsPanel(
  metrics: MetricsSnapshot,
  view: MetricsView,
  maxLen = TELEGRAM_MESSAGE_MAX,
): string {
  return renderMetricsPanelWith(
    metrics,
    TELEGRAM_REPORTS,
    VIEW_TITLES[view],
    maxLen,
    TOOL_CALLS_TOP_N,
  );
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

/** Render the `/usage` report — one block per exposed backend. */
export function renderUsageMessage(entries: BackendUsageEntry[]): string {
  return renderUsageMessageWith(entries, TELEGRAM_REPORTS);
}

/**
 * Render a DoctorReport as one Telegram HTML message. Same data as
 * `talon doctor` (src/core/doctor/) plus in-process runtime info — when
 * this renders, the bot is by definition running, so the CLI's "is the
 * bot up" probe becomes an uptime line instead.
 */
export function renderDoctorMessage(report: DoctorReport): string {
  return renderDoctorReport(report, TELEGRAM_REPORTS);
}

// ── /mesh ───────────────────────────────────────────────────────────────────

/**
 * Render the `/mesh` fleet report as one HTML message, with the bridge
 * footer appended when the caller supplies reachability.
 */
export function renderMeshReport(
  results: MeshPingResult[],
  now = Date.now(),
  bridge?: MeshReachability,
): string {
  // An empty fleet is the one case where "what do I point a device at?" is
  // the only useful thing to say, so the bridge line carries the answer
  // instead of leaving the operator to hunt for host and port.
  return renderMeshReportWith(
    results,
    TELEGRAM_REPORTS,
    now,
    bridgeLines(bridge),
  );
}

/** What `/mesh` says about the bridge a new device would dial. */
export type MeshReachability =
  | {
      ok: true;
      url: string;
      authRequired: boolean;
      token?: string;
      fingerprint?: string;
    }
  | { ok: false; text: string };

/**
 * The bridge footer.
 *
 * The bearer token and certificate appear when the caller passed them, which
 * `/mesh` does for the configured admin and not for anyone else: an operator
 * asking their own daemon how to reach itself should get the answer, while a
 * group member reading the fleet has no business holding the key to it.
 */
function bridgeLines(bridge?: MeshReachability): string[] {
  if (!bridge) return [];
  if (!bridge.ok) return ["", `<b>Bridge</b> — ${escapeHtml(bridge.text)}`];
  const auth = bridge.authRequired ? "token required" : "no token";
  return [
    "",
    `<b>Bridge</b> <code>${escapeHtml(bridge.url)}</code> · ${auth}`,
    ...(bridge.token ? [`Token <code>${escapeHtml(bridge.token)}</code>`] : []),
    ...(bridge.fingerprint
      ? [`Certificate <code>${escapeHtml(bridge.fingerprint)}</code>`]
      : []),
    "Run <code>/mesh link</code> for a one-tap pairing link.",
  ];
}

/**
 * Render a minted pairing link, or why one couldn't be minted.
 *
 * The values are printed alongside the link because the link's whole payoff
 * — the phone configuring itself — depends on the companion already being
 * installed, and the fallback needs to be right there when it isn't.
 */
export function renderMeshPairLink(
  minted:
    | {
        ok: true;
        link: string;
        url: string;
        token: string;
        fingerprint?: string;
      }
    | { ok: false; text: string },
): string {
  if (!minted.ok) {
    return `<b>Pairing</b>\n\n${escapeHtml(minted.text)}`;
  }
  return [
    "<b>Pair a device</b>",
    "",
    `Open on the phone: ${escapeHtml(minted.link)}`,
    "",
    "Single-use, expires in 10 minutes. If the companion isn't installed yet:",
    `  Bridge <code>${escapeHtml(minted.url)}</code>`,
    `  Token <code>${escapeHtml(minted.token)}</code>`,
    ...(minted.fingerprint
      ? [`  Certificate <code>${escapeHtml(minted.fingerprint)}</code>`]
      : []),
  ].join("\n");
}
