/**
 * `metrics:today` | `metrics:all` — the /metrics today ↔ all-time toggle.
 */

import { metricsViewRow, renderMetricsView } from "../../commands/admin.js";
import type { ComponentInteraction } from "./types.js";

export async function handleMetricsComponent(
  interaction: ComponentInteraction,
): Promise<boolean> {
  const customId = interaction.customId;
  if (customId !== "metrics:today" && customId !== "metrics:all") return false;
  const view = customId === "metrics:all" ? "all" : "today";
  const messages = renderMetricsView(view);
  try {
    await interaction.update({
      content: messages[0]!,
      components: [metricsViewRow(view).toJSON()],
    });
  } catch {
    /* ignore */
  }
  return true;
}
