/**
 * `metrics:*` callbacks — swap the /metrics panel between the today and
 * all-time grains by editing the message in place.
 *
 * Admin-gated like the command that posts the panel: in a group chat the
 * buttons sit on a message anyone can tap.
 */

import type { Context } from "grammy";
import { getMetrics, getTodayMetrics } from "../../../util/metrics.js";
import {
  renderMetricsKeyboard,
  renderMetricsPanel,
  type MetricsView,
} from "../helpers/index.js";
import { isAuthorizedAdmin } from "../commands/state.js";
import { answerCallbackQuerySafe, editOrIgnoreSame } from "./shared.js";

export async function handleMetricsCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  if (!isAuthorizedAdmin(ctx)) {
    await answerCallbackQuerySafe(ctx, { text: "Not authorized." });
    return;
  }

  const view: MetricsView = data === "metrics:all" ? "all" : "today";
  await answerCallbackQuerySafe(ctx);
  const metrics = view === "all" ? getMetrics() : getTodayMetrics();
  await editOrIgnoreSame(
    ctx,
    renderMetricsPanel(metrics, view),
    renderMetricsKeyboard(view),
  );
}
