/**
 * Telegram's dialect of the shared chat reports.
 *
 * `frontend/presentation/reports.ts` writes each report once and takes
 * the markup spelling from a `ReportFormatter`; this is Telegram's.
 * `escape` is `escapeHtml` because sends use `parse_mode: HTML`, so a
 * literal `<` in a device name, a model id, a metric key or a backend
 * note would be read as a tag and 400 the entire message.
 *
 * Its own module so both `reports.ts` (the report wrappers) and
 * `menu.ts` (the settings body) can read it without a cycle.
 */

import { escapeHtml } from "../formatting.js";
import type { ReportFormatter } from "../../presentation/reports.js";

/** Telegram hard-caps a message at 4096 characters; this leaves headroom. */
export const TELEGRAM_MESSAGE_MAX = 3800;

export const TELEGRAM_REPORTS: ReportFormatter = {
  bold: (s) => `<b>${s}</b>`,
  italic: (s) => `<i>${s}</i>`,
  // Telegram has one italic tag; Discord spells this one `*…*`.
  emphasis: (s) => `<i>${s}</i>`,
  code: (s) => `<code>${s}</code>`,
  escape: escapeHtml,
  lineLimit: TELEGRAM_MESSAGE_MAX,
  metricLabelMax: 80,
  pulseLabel: "Pulse:",
};
