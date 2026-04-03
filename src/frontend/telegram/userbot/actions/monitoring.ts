/**
 * Self-monitoring actions: performance reports, tool usage stats.
 */

import {
  getMetrics,
  getPerformanceReport,
} from "../../../../storage/self-monitor.js";
import type { ActionRegistry } from "./index.js";

export function registerMonitoringActions(registry: ActionRegistry) {
  registry.set("get_performance_report", async () => {
    return { ok: true, report: getPerformanceReport(), text: getPerformanceReport() };
  });

  registry.set("get_tool_usage_stats", async () => {
    const metrics = getMetrics();
    const sorted = Object.entries(metrics.toolUsage).sort((a, b) => b[1] - a[1]);
    const tools = sorted.map(([name, count]) => ({ name, count }));

    if (tools.length === 0) {
      return { ok: true, text: "No tool usage data yet.", tools: [] };
    }

    const formatted = tools.map((t) => `${t.name}: ${t.count}`);
    return { ok: true, text: formatted.join("\n"), tools };
  });
}
