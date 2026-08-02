/**
 * Terminal command registry — extensible slash command system.
 *
 * Each command is a self-contained handler registered via `registerCommand()`.
 * New commands = one function call. Handlers are independently testable.
 */

import pc from "picocolors";
import type { TalonConfig } from "../../util/config.js";
import type { Backend } from "../../core/agent-runtime/capabilities.js";
import type { Renderer } from "./renderer.js";
import { formatTimeAgo } from "./renderer.js";
import { isTerminalChatId } from "../../util/chat-id.js";
import {
  resolveModel as coreResolveModel,
  getModels,
} from "../../core/models/catalog.js";
import {
  buildCacheDisplay,
  buildContextDisplay,
  buildPlanDisplay,
  buildContextBreakdown,
  estimateContextTokens,
  apportionCells,
  type ContextBreakdown,
  type ContextSegmentKey,
} from "../shared/status-context.js";
import { getRecentHistory } from "../../storage/history.js";
import {
  formatDuration,
  formatTokenCount,
  formatUsd,
} from "../shared/format.js";
import {
  getChatSettings,
  setChatModel,
  setChatEffort,
} from "../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../core/models/catalog.js";
import {
  getAllSessions,
  getSession,
  getSessionInfo,
  setSessionName,
} from "../../storage/sessions.js";
import { getLoadedPlugins } from "../../core/plugin/index.js";
import { getPooledBackend } from "../../core/engine/backend-controller/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type CommandContext = {
  /** Current chat ID (getter — may change on /resume). */
  chatId: () => string;
  config: TalonConfig;
  renderer: Renderer;
  reprompt: () => void;
  initNewChat: (id?: string) => void;
  waitForInput: () => Promise<string>;
  /** Close the terminal (for /quit). */
  close: () => void;
  /** AI backend (available after bootstrap). */
  backend?: Backend | null;
};

export type CommandHandler = (
  args: string,
  ctx: CommandContext,
) => Promise<void>;

export type Command = {
  name: string;
  aliases?: string[];
  argHint?: string;
  description: string;
  handler: CommandHandler;
};

// ── Registry ─────────────────────────────────────────────────────────────────

const commands: Command[] = [];
const nameIndex = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  commands.push(cmd);
  nameIndex.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      nameIndex.set(alias, cmd);
    }
  }
}

/** Try to run a slash command. Returns true if handled, false if not a command. */
export async function tryRunCommand(
  text: string,
  ctx: CommandContext,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;

  const spaceIdx = text.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? text : text.slice(0, spaceIdx))
    .slice(1)
    .toLowerCase();
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

  const cmd = nameIndex.get(cmdName);
  if (!cmd) return false;

  await cmd.handler(args, ctx);
  return true;
}

/** Get all registered commands (for /help rendering). */
export function getCommands(): readonly Command[] {
  return commands;
}

/** Clear all registered commands (for testing). */
export function clearCommands(): void {
  commands.length = 0;
  nameIndex.clear();
}

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

// ── Built-in commands ────────────────────────────────────────────────────────

export function registerBuiltinCommands(): void {
  registerCommand({
    name: "model",
    argHint: "[name]",
    description: "Switch model",
    async handler(args, ctx) {
      const currentModel =
        getChatSettings(ctx.chatId()).model ?? ctx.config.model;
      const be = ctx.backend;

      const trimmedArgs = args.trim();
      const lowerArgs = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        const modelInfo = await be?.models?.getRawModelInfo?.(currentModel);
        const displayName = modelInfo?.displayName ?? currentModel;
        const details = modelInfo
          ? [
              modelInfo.providerName,
              modelInfo.free ? "free" : undefined,
              modelInfo.selectable
                ? "ready"
                : (modelInfo.unavailableReason ?? "not connected"),
            ].filter(Boolean)
          : [];
        ctx.renderer.writeSystem(
          `Model: ${displayName}${details.length ? ` · ${details.join(" · ")}` : ""}`,
        );
        if (modelInfo?.contextWindow) {
          ctx.renderer.writeln(
            `  Context window: ${modelInfo.contextWindow.toLocaleString()}`,
          );
        }
        if (be?.models?.getProviders) {
          const providers = await be.models?.getProviders();
          const connected = providers.filter((p) => p.connected);
          if (connected.length > 0) {
            ctx.renderer.writeln(
              `  Providers: ${connected.map((p) => `${p.name} (${p.modelCount})`).join(", ")}`,
            );
          }
        }
        ctx.renderer.writeln(
          `  Use /model free, /model all, /model providers, or /model <name>.`,
        );
        ctx.reprompt();
        return;
      }

      if (lowerArgs === "reset" || lowerArgs === "default") {
        setChatModel(ctx.chatId(), undefined);
        ctx.renderer.writeSystem(`Model → ${ctx.config.model}`);
        ctx.reprompt();
        return;
      }

      if (lowerArgs === "free" || lowerArgs === "list" || lowerArgs === "all") {
        if (be?.models?.listModels) {
          const filter = lowerArgs === "free" ? "free" : "all";
          const { models, total } = await be.models.listModels(filter);
          const list = models.slice(0, 20);
          ctx.renderer.writeSystem(
            `${filter === "free" ? "Free" : "Available"} models (${total})`,
          );
          for (const model of list) {
            ctx.renderer.writeln(
              `  ${model.displayName}  ·  ${model.providerName}${model.contextWindow ? `  ·  ${model.contextWindow.toLocaleString()} ctx` : ""}${model.free ? "  ·  free" : ""}`,
            );
          }
          if (total > list.length) {
            ctx.renderer.writeln(`  …and ${total - list.length} more`);
          }
        } else {
          const names = getModels()
            .map((m) => m.aliases[0] ?? m.id)
            .join(", ");
          ctx.renderer.writeSystem(`Available: ${names}`);
        }
        ctx.reprompt();
        return;
      }

      if (lowerArgs === "providers") {
        if (be?.models?.getProviders) {
          const providers = await be.models?.getProviders();
          ctx.renderer.writeSystem(`Providers (${providers.length})`);
          for (const p of providers.slice(0, 20)) {
            ctx.renderer.writeln(
              `  ${p.name}  ·  ${p.connected ? "connected" : "not connected"}  ·  ${p.modelCount} models`,
            );
          }
        } else {
          ctx.renderer.writeSystem("Provider listing not supported.");
        }
        ctx.reprompt();
        return;
      }

      // Resolve model query via backend
      if (be?.models?.resolveModelInfo) {
        const resolution = await be.models?.resolveModelInfo(trimmedArgs);
        if (resolution.kind === "missing") {
          const msg =
            be.models?.formatModelError?.(trimmedArgs, resolution) ??
            `No model matched "${trimmedArgs}".`;
          ctx.renderer.writeError(msg);
          ctx.reprompt();
          return;
        }
        if (resolution.kind === "ambiguous") {
          const preview = resolution.matches
            .map((m) => `${m.displayName} (${m.providerName})`)
            .join(", ");
          ctx.renderer.writeError(
            `Ambiguous: "${trimmedArgs}" matches ${preview}`,
          );
          ctx.reprompt();
          return;
        }
        if (!resolution.model.selectable) {
          ctx.renderer.writeError(
            resolution.model.unavailableReason ??
              `${resolution.model.providerName} is not connected.`,
          );
          ctx.reprompt();
          return;
        }
        setChatModel(ctx.chatId(), resolution.storedValue);
        ctx.renderer.writeSystem(
          `Model → ${resolution.model.displayName} (${resolution.model.providerName}${resolution.model.free ? " · free" : ""})`,
        );
      } else {
        setChatModel(ctx.chatId(), resolveModelName(trimmedArgs));
        ctx.renderer.writeSystem(`Model → ${resolveModelName(trimmedArgs)}`);
      }
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "effort",
    argHint: "[lvl]",
    description: "Thinking effort (off/low/medium/high/max)",
    async handler(args, ctx) {
      if (!args) {
        ctx.renderer.writeSystem(
          `Effort: ${getChatSettings(ctx.chatId()).effort ?? "adaptive"}`,
        );
      } else {
        setChatEffort(
          ctx.chatId(),
          args === "adaptive"
            ? undefined
            : (args as "off" | "low" | "medium" | "high" | "max"),
        );
        ctx.renderer.writeSystem(`Effort → ${args}`);
      }
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "status",
    description: "Session stats",
    async handler(_args, ctx) {
      const info = getSessionInfo(ctx.chatId());
      const u = info.usage;
      const be = ctx.backend;
      const activeModel =
        getChatSettings(ctx.chatId()).model ?? ctx.config.model;
      let displayInputTokens = u.totalInputTokens;
      let displayOutputTokens = u.totalOutputTokens;
      let displayCacheRead = u.totalCacheRead;
      let displayCacheWrite = u.totalCacheWrite;
      let backendModelLine = "";
      let contextWindow = u.contextWindow;
      ctx.renderer.writeln();
      const nameStr = info.sessionName ? `"${info.sessionName}"  ·  ` : "";

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

      const cache = buildCacheDisplay({
        cacheMetrics: be?.cacheMetrics,
        inputTokens: displayInputTokens,
        cacheRead: displayCacheRead,
        cacheWrite: displayCacheWrite,
      });
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

      const context = buildContextDisplay({
        contextTokens: u.contextTokens,
        lastPromptTokens: u.lastPromptTokens,
        contextWindow,
      });
      const contextUsed = context.known
        ? formatTokenCount(context.used)
        : "unknown";
      const contextMax = context.max
        ? formatTokenCount(context.max)
        : "unknown";
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
        `  ${pc.dim(`in ${displayInputTokens.toLocaleString()}  ·  out ${displayOutputTokens.toLocaleString()} tokens`)}`,
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

      const planSource = be?.usage?.getPlanUsage
        ? be
        : getPooledBackend("claude");
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
      if (backendModelLine) {
        ctx.renderer.writeln();
        ctx.renderer.writeln(backendModelLine);
      }

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
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "context",
    aliases: ["ctx"],
    description: "Context-window usage, broken down",
    async handler(_args, ctx) {
      const chatId = ctx.chatId();
      const u = getSessionInfo(chatId).usage;
      const be = ctx.backend;
      const activeModel = getChatSettings(chatId).model ?? ctx.config.model;

      // Window + a friendly model name, enriched from the backend like /status.
      let contextWindow = u.contextWindow;
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
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "reset",
    description: "Start a fresh session",
    async handler(_args, ctx) {
      ctx.initNewChat();
      ctx.renderer.writeSystem("Session cleared.");
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "resume",
    description: "List & resume a past session",
    async handler(_args, ctx) {
      const sessions = getAllSessions()
        .filter(
          (s) =>
            isTerminalChatId(s.chatId) &&
            s.chatId !== ctx.chatId() &&
            s.info.turns > 0,
        )
        .sort((a, b) => b.info.lastActive - a.info.lastActive)
        .slice(0, 10);

      if (sessions.length === 0) {
        ctx.renderer.writeSystem("No previous sessions to resume.");
        ctx.reprompt();
        return;
      }

      ctx.renderer.writeln();
      ctx.renderer.writeln(`  ${pc.bold("Past sessions")}`);
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i]!;
        const name = s.info.sessionName
          ? `"${s.info.sessionName}"`
          : pc.dim("(unnamed)");
        const turns = `${s.info.turns} turn${s.info.turns !== 1 ? "s" : ""}`;
        const ago = formatTimeAgo(s.info.lastActive);
        const model = s.info.lastModel
          ? (coreResolveModel(s.info.lastModel)?.displayName ??
            s.info.lastModel)
          : "";
        ctx.renderer.writeln(
          `  ${pc.green(String(i + 1))}. ${name}  ${pc.dim(`${turns}  ·  ${ago}${model ? `  ·  ${model}` : ""}`)}`,
        );
      }
      ctx.renderer.writeln();
      ctx.renderer.writeln(
        `  ${pc.dim("Enter number to resume (Esc to cancel):")}`,
      );

      const input = await ctx.waitForInput();
      const num = parseInt(input, 10);
      if (num >= 1 && num <= sessions.length) {
        const selected = sessions[num - 1]!;
        ctx.initNewChat(selected.chatId);
        const name = selected.info.sessionName
          ? `"${selected.info.sessionName}"`
          : `(${selected.info.turns} turns)`;
        ctx.renderer.writeSystem(`Resumed: ${name}`);
      } else {
        ctx.renderer.writeSystem("Cancelled.");
      }
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "rename",
    argHint: "[name]",
    description: "Name the current session",
    async handler(args, ctx) {
      // Ensure session exists in store (auto-creates if needed)
      getSession(ctx.chatId());
      if (!args) {
        const session = getSession(ctx.chatId());
        ctx.renderer.writeSystem(
          session.sessionName
            ? `Session name: "${session.sessionName}"`
            : "Session has no name.",
        );
      } else {
        setSessionName(ctx.chatId(), args);
        ctx.renderer.writeSystem(`Session renamed to "${args}"`);
      }
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "help",
    description: "Show available commands",
    async handler(_args, ctx) {
      ctx.renderer.writeln();
      for (const cmd of getCommands()) {
        if (cmd.name === "help") continue; // show help last
        const nameStr = `/${cmd.name}`;
        const argStr = cmd.argHint ? ` ${cmd.argHint}` : "";
        const pad = " ".repeat(
          Math.max(1, 16 - nameStr.length - argStr.length),
        );
        ctx.renderer.writeln(
          `  ${pc.cyan(nameStr)}${pc.dim(argStr)}${pad}${pc.dim(cmd.description)}`,
        );
      }
      // Help itself at the end
      ctx.renderer.writeln(
        `  ${pc.cyan("/help")}           ${pc.dim("Show available commands")}`,
      );
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "quit",
    aliases: ["exit"],
    description: "Exit",
    async handler(_args, ctx) {
      ctx.close();
    },
  });
}
