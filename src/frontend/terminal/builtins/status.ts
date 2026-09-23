/** `/status` — session stats, enriched from the backend when available. */

import pc from "picocolors";
import {
  buildCacheDisplay,
  buildContextDisplay,
  buildPlanDisplay,
} from "../../presentation/status-context.js";
import {
  formatDuration,
  formatTokenCount,
  formatUsd,
} from "../../presentation/format.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { getSessionInfo } from "../../../storage/sessions.js";
import { getLoadedPlugins } from "../../../core/plugin/index.js";
import {
  getPoolConfig,
  getPooledBackend,
} from "../../../core/engine/backend-controller/index.js";
import {
  collectBackendUsage,
  formatHeadroom,
} from "../../../core/engine/backend-router/index.js";
import type { Command, CommandContext } from "../command-registry.js";

type BackendRef = CommandContext["backend"];
type SessionInfo = ReturnType<typeof getSessionInfo>;

type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Stored totals, replaced by the backend's live snapshot when available. */
async function liveUsageTotals(
  be: BackendRef,
  info: SessionInfo,
): Promise<UsageTotals> {
  const u = info.usage;
  let displayInputTokens = u.totalInputTokens;
  let displayOutputTokens = u.totalOutputTokens;
  let displayCacheRead = u.totalCacheRead;
  let displayCacheWrite = u.totalCacheWrite;

  // Enrich from backend when available
  if (be?.usage?.getSessionSnapshot && info.sessionId) {
    const snap = await be.usage
      ?.getSessionSnapshot(info.sessionId)
      .catch(() => undefined);
    if (snap) {
      displayInputTokens = snap.inputTokens ?? displayInputTokens;
      displayOutputTokens = snap.outputTokens ?? displayOutputTokens;
      displayCacheRead = snap.cacheRead ?? displayCacheRead;
      displayCacheWrite = snap.cacheWrite ?? displayCacheWrite;
    }
  }
  return {
    inputTokens: displayInputTokens,
    outputTokens: displayOutputTokens,
    cacheRead: displayCacheRead,
    cacheWrite: displayCacheWrite,
  };
}

/** The backend's model line, plus its context window if the store had none. */
async function backendModelSummary(
  be: BackendRef,
  activeModel: string,
  contextWindow: number,
): Promise<{ line: string; contextWindow: number }> {
  let backendModelLine = "";
  if (be?.models?.getRawModelInfo) {
    const modelInfo = await be.models
      ?.getRawModelInfo(activeModel)
      .catch(() => undefined);
    const label = be.label ?? "Backend";
    if (modelInfo) {
      backendModelLine = `  ${pc.bold(label)}  ${modelInfo.displayName}  ·  ${modelInfo.providerName}${modelInfo.free ? " · free" : ""}`;
      if (modelInfo.contextWindow) {
        contextWindow ||= modelInfo.contextWindow;
      }
    }
  }
  return { line: backendModelLine, contextWindow };
}

function writeSessionAndContext(
  ctx: CommandContext,
  info: SessionInfo,
  totals: UsageTotals,
  cache: ReturnType<typeof buildCacheDisplay>,
  contextWindow: number,
): void {
  const u = info.usage;
  const nameStr = info.sessionName ? `"${info.sessionName}"  ·  ` : "";
  const context = buildContextDisplay({
    contextTokens: u.contextTokens,
    lastPromptTokens: u.lastPromptTokens,
    contextWindow,
  });
  const contextUsed = context.known
    ? formatTokenCount(context.used)
    : "unknown";
  const contextMax = context.max ? formatTokenCount(context.max) : "unknown";
  const avgResponseMs =
    info.turns > 0 && u.totalResponseMs
      ? Math.round(u.totalResponseMs / info.turns)
      : 0;
  const fastestResponseMs =
    Number.isFinite(u.fastestResponseMs) && u.fastestResponseMs > 0
      ? u.fastestResponseMs
      : 0;

  ctx.renderer.writeln(
    `  ${pc.bold("Session")}  ${nameStr}turns ${info.turns}${cache ? `  ·  ${cache.hitPct}% cache` : ""}`,
  );
  ctx.renderer.writeln(
    `  ${pc.dim(`in ${totals.inputTokens.toLocaleString()}  ·  out ${totals.outputTokens.toLocaleString()} tokens`)}`,
  );
  ctx.renderer.writeln();
  ctx.renderer.writeln(
    `  ${pc.bold("Context")}  ${contextUsed} / ${contextMax} (${context.known ? `${context.pct}%` : "unknown"})${context.warn ? pc.yellow("  nearing limit") : ""}`,
  );
  ctx.renderer.writeln(
    `  ${context.warn ? pc.yellow(context.bar) : pc.dim(context.bar)}`,
  );
  ctx.renderer.writeln(
    `  ${pc.dim(`response last ${u.lastResponseMs ? formatDuration(u.lastResponseMs) : "—"}  ·  avg ${avgResponseMs ? formatDuration(avgResponseMs) : "—"}  ·  best ${fastestResponseMs ? formatDuration(fastestResponseMs) : "—"}`)}`,
  );
  if (u.estimatedCostUsd > 0) {
    ctx.renderer.writeln(
      `  ${pc.dim(`estimated session cost ${formatUsd(u.estimatedCostUsd)}`)}`,
    );
  }
}

async function writePlan(ctx: CommandContext, be: BackendRef): Promise<void> {
  const planSource = be?.usage?.getPlanUsage ? be : getPooledBackend("claude");
  const plan = buildPlanDisplay(
    await planSource?.usage?.getPlanUsage?.().catch(() => undefined),
  );
  if (plan) {
    ctx.renderer.writeln();
    ctx.renderer.writeln(
      `  ${pc.bold("Plan")}${plan.plan ? `  ${plan.plan}` : ""}${plan.ageLabel ? pc.dim(`  (${plan.ageLabel})`) : ""}`,
    );
    for (const w of plan.windows) {
      ctx.renderer.writeln(
        `  ${w.label.padEnd(6)}${pc.dim(w.bar)} ${String(w.percent).padStart(3)}%${w.resetLabel ? pc.dim(`  reset ${w.resetLabel}`) : ""}`,
      );
    }
  }
  await writeHeadroom(ctx);
}

/**
 * What the plan-aware router sees: one comparable figure per backend, so
 * "why did that sub-agent run on agy?" is answerable from `/status`.
 * Ledger-derived rows say so — they are Talon's own count, not the
 * provider's.
 */
async function writeHeadroom(ctx: CommandContext): Promise<void> {
  const entries = await collectBackendUsage(getPoolConfig() ?? undefined).catch(
    () => [],
  );
  if (entries.length === 0) return;
  ctx.renderer.writeln();
  ctx.renderer.writeln(`  ${pc.bold("Headroom")}`);
  for (const entry of entries) {
    ctx.renderer.writeln(
      `  ${(entry.label || entry.id).padEnd(14)}${pc.dim(formatHeadroom(entry.headroom))}`,
    );
  }
}

function writePlugins(ctx: CommandContext): void {
  const plugins = getLoadedPlugins();
  if (plugins.length > 0) {
    ctx.renderer.writeln();
    ctx.renderer.writeln(`  ${pc.bold("Plugins")}`);
    for (const p of plugins) {
      const ver = p.plugin.version ? pc.dim(` v${p.plugin.version}`) : "";
      const desc = p.plugin.description
        ? `  ${pc.dim(p.plugin.description)}`
        : "";
      const tools = p.plugin.mcpServerPath
        ? pc.green("mcp")
        : pc.dim("actions only");
      ctx.renderer.writeln(
        `  ${pc.green("●")} ${p.plugin.name}${ver}  ${tools}${desc}`,
      );
    }
  }
}

export const statusCommand: Command = {
  name: "status",
  description: "Session stats",
  async handler(_args, ctx) {
    const info = getSessionInfo(ctx.chatId());
    const be = ctx.backend;
    const activeModel = getChatSettings(ctx.chatId()).model ?? ctx.config.model;
    ctx.renderer.writeln();

    const totals = await liveUsageTotals(be, info);
    const cache = buildCacheDisplay({
      cacheMetrics: be?.cacheMetrics,
      inputTokens: totals.inputTokens,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
    });
    const model = await backendModelSummary(
      be,
      activeModel,
      info.usage.contextWindow,
    );

    writeSessionAndContext(ctx, info, totals, cache, model.contextWindow);
    await writePlan(ctx, be);
    if (model.line) {
      ctx.renderer.writeln();
      ctx.renderer.writeln(model.line);
    }
    writePlugins(ctx);
    ctx.reprompt();
  },
};
