/** `/context` — the context window, broken down by segment. */

import pc from "picocolors";
import {
  buildContextBreakdown,
  estimateContextTokens,
  apportionCells,
  type ContextBreakdown,
  type ContextSegmentKey,
} from "../../shared/status-context.js";
import { getRecentHistory } from "../../../storage/history.js";
import { formatTokenCount } from "../../shared/format.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../core/models/catalog.js";
import { getSessionInfo } from "../../../storage/sessions.js";
import type { Command, CommandContext } from "../command-registry.js";

// ── /context rendering ───────────────────────────────────────────────────────

/** Each used segment gets its own colour; free is a dim hatch. */
const CONTEXT_SEGMENT_COLOR: Record<ContextSegmentKey, (s: string) => string> =
  {
    system: pc.blue,
    tools: pc.yellow,
    conversation: pc.cyan,
  };

const CONTEXT_BAR_WIDTH = 42;

/**
 * The segmented bar: one coloured run per segment (proportional to the window),
 * then the free space as a dim `░` hatch. Cell counts come from
 * `apportionCells`, so the runs always sum to exactly the bar width.
 */
function renderContextBar(bd: ContextBreakdown): string {
  const weights = bd.segments.map((s) => s.tokens);
  if (bd.windowKnown) weights.push(bd.free);
  const cells = apportionCells(weights, CONTEXT_BAR_WIDTH);
  let bar = "";
  bd.segments.forEach((s, i) => {
    bar += CONTEXT_SEGMENT_COLOR[s.key]("█".repeat(cells[i] ?? 0));
  });
  if (bd.windowKnown) {
    bar += pc.dim("░".repeat(cells[bd.segments.length] ?? 0));
  }
  return bar;
}

/** One aligned legend row per segment (and Free), colour-matched to the bar. */
function renderContextLegend(bd: ContextBreakdown): string[] {
  const rows = bd.segments.map((s) => ({
    dot: CONTEXT_SEGMENT_COLOR[s.key]("●"),
    label: s.label,
    tokens: s.tokens,
    pct: s.pct,
  }));
  if (bd.windowKnown) {
    rows.push({
      dot: pc.dim("░"),
      label: "Free",
      tokens: bd.free,
      pct: bd.freePct,
    });
  }
  const labelW = Math.max(...rows.map((r) => r.label.length));
  const tokW = Math.max(...rows.map((r) => formatTokenCount(r.tokens).length));
  return rows.map((r) => {
    const label = r.label.padEnd(labelW);
    const tok = formatTokenCount(r.tokens).padStart(tokW);
    const pct = `${r.pct}%`.padStart(6);
    return `${r.dot} ${label}  ${pc.dim(tok)}  ${pc.dim(pct)}`;
  });
}

// ── /context ─────────────────────────────────────────────────────────────────

/** Window + a friendly model name, enriched from the backend like /status. */
async function resolveWindowAndModel(
  be: CommandContext["backend"],
  activeModel: string,
  contextWindow: number,
): Promise<{ contextWindow: number; modelName: string }> {
  let modelName = resolveModelName(activeModel);
  if (be?.models?.getRawModelInfo) {
    const mi = await be.models
      .getRawModelInfo(activeModel)
      .catch(() => undefined);
    if (mi) {
      if (mi.contextWindow) contextWindow ||= mi.contextWindow;
      if (mi.displayName) modelName = mi.displayName;
    }
  }
  return { contextWindow, modelName };
}

function writeContextReport(
  ctx: CommandContext,
  bd: ContextBreakdown,
  modelName: string,
): void {
  const windowStr = bd.windowKnown
    ? `${formatTokenCount(bd.max)} window`
    : pc.dim("window unknown");
  ctx.renderer.writeln(
    `  ${pc.bold("Context")}  ${modelName}  ·  ${windowStr}`,
  );

  const usedStr = bd.windowKnown
    ? `${formatTokenCount(bd.used)} / ${formatTokenCount(bd.max)}  ·  ${bd.usedPct}% used`
    : `${formatTokenCount(bd.used)} used`;
  ctx.renderer.writeln(
    `  ${bd.warn ? pc.yellow(usedStr) : pc.dim(usedStr)}${bd.warn ? pc.yellow("  · nearing limit") : ""}`,
  );
  ctx.renderer.writeln();
  ctx.renderer.writeln(`  ${renderContextBar(bd)}`);
  ctx.renderer.writeln();
  for (const line of renderContextLegend(bd)) {
    ctx.renderer.writeln(`  ${line}`);
  }
  // Explain only what's on screen: Tools is derivable (and shown) only
  // when the backend reported a real fill.
  const hasTools = bd.segments.some((s) => s.key === "tools");
  ctx.renderer.writeln(
    `  ${pc.dim(
      hasTools
        ? "System measured; Conversation estimated; Tools is the remainder."
        : "System measured; Conversation estimated from stored history.",
    )}`,
  );
}

export const contextCommand: Command = {
  name: "context",
  aliases: ["ctx"],
  description: "Context-window usage, broken down",
  async handler(_args, ctx) {
    const chatId = ctx.chatId();
    const u = getSessionInfo(chatId).usage;
    const be = ctx.backend;
    const activeModel = getChatSettings(chatId).model ?? ctx.config.model;

    const { contextWindow, modelName } = await resolveWindowAndModel(
      be,
      activeModel,
      u.contextWindow,
    );

    // System = the actual frozen prompt the model is running with. Measure
    // it directly rather than rebuilding, so the number matches what was
    // really sent (the prompt is frozen per session by design).
    const parts = ctx.config.systemPromptParts;
    const systemText = parts
      ? [parts.staticText, parts.dynamicText].filter(Boolean).join("\n")
      : (ctx.config.systemPrompt ?? "");
    const systemTokens = estimateContextTokens(systemText);

    // Conversation = stored history for this chat. An estimate: the model's
    // real in-window history may be smaller after compaction, which the
    // breakdown clamps against the authoritative fill.
    const history = getRecentHistory(chatId, 2000);
    const conversationTokens = estimateContextTokens(
      history.map((m) => m.text ?? "").join("\n"),
    );

    const bd = buildContextBreakdown({
      contextTokens: u.contextTokens,
      contextWindow,
      systemTokens,
      conversationTokens,
    });

    ctx.renderer.writeln();
    if (!bd.known) {
      ctx.renderer.writeln(
        `  ${pc.bold("Context")}  ${pc.dim("no usage yet — send a message first")}`,
      );
      ctx.reprompt();
      return;
    }

    writeContextReport(ctx, bd, modelName);
    ctx.reprompt();
  },
};
