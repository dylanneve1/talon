/**
 * Terminal command registry — extensible slash command system.
 *
 * Each command is a self-contained handler registered via `registerCommand()`.
 * New commands = one function call. Handlers are independently testable.
 */

import pc from "picocolors";
import type { TalonConfig } from "../../util/config.js";
import type { QueryBackend } from "../../core/types.js";
import type { Renderer } from "./renderer.js";
import { formatTimeAgo } from "./renderer.js";
import { isTerminalChatId } from "../../util/chat-id.js";
import { resolveModel as coreResolveModel } from "../../core/models.js";

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
  backend?: QueryBackend | null;
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

// ── Built-in commands ────────────────────────────────────────────────────────

export function registerBuiltinCommands(): void {
  registerCommand({
    name: "model",
    argHint: "[name]",
    description: "Switch model",
    async handler(args, ctx) {
      const { getChatSettings, setChatModel, resolveModelName } =
        await import("../../storage/chat-settings.js");
      const currentModel =
        getChatSettings(ctx.chatId()).model ?? ctx.config.model;
      const be = ctx.backend;

      const trimmedArgs = args.trim();
      const lowerArgs = trimmedArgs.toLowerCase();

      if (!trimmedArgs) {
        const modelInfo = await be?.getModelInfo?.(currentModel);
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
        if (be?.getProviders) {
          const providers = await be.getProviders();
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

      if (
        lowerArgs === "free" ||
        lowerArgs === "list" ||
        lowerArgs === "all"
      ) {
        if (be?.listModels) {
          const filter = lowerArgs === "free" ? "free" : "all";
          const { models, total } = await be.listModels(filter);
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
          const { getModels } = await import("../../core/models.js");
          const names = getModels()
            .map((m) => m.aliases[0] ?? m.id)
            .join(", ");
          ctx.renderer.writeSystem(`Available: ${names}`);
        }
        ctx.reprompt();
        return;
      }

      if (lowerArgs === "providers") {
        if (be?.getProviders) {
          const providers = await be.getProviders();
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
      if (be?.resolveModel) {
        const resolution = await be.resolveModel(trimmedArgs);
        if (resolution.kind === "missing") {
          const msg =
            be.formatModelError?.(trimmedArgs, resolution) ??
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
      const { getChatSettings, setChatEffort } =
        await import("../../storage/chat-settings.js");
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
      const { getSessionInfo } = await import("../../storage/sessions.js");
      const { getChatSettings } =
        await import("../../storage/chat-settings.js");
      const { getLoadedPlugins } = await import("../../core/plugin.js");
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
      let backendContextLine = "";
      ctx.renderer.writeln();
      const nameStr = info.sessionName ? `"${info.sessionName}"  ·  ` : "";

      // Enrich from backend when available
      if (be?.getSessionSnapshot && info.sessionId) {
        const snap = await be
          .getSessionSnapshot(info.sessionId)
          .catch(() => undefined);
        if (snap) {
          displayInputTokens = snap.inputTokens ?? displayInputTokens;
          displayOutputTokens = snap.outputTokens ?? displayOutputTokens;
          displayCacheRead = snap.cacheRead ?? displayCacheRead;
          displayCacheWrite = snap.cacheWrite ?? displayCacheWrite;
        }
      }

      if (be?.getModelInfo) {
        const modelInfo = await be.getModelInfo(activeModel).catch(() => undefined);
        const label = be.backendLabel ?? "Backend";
        if (modelInfo) {
          backendModelLine = `  ${pc.bold(label)}  ${modelInfo.displayName}  ·  ${modelInfo.providerName}${modelInfo.free ? " · free" : ""}`;
          if (modelInfo.contextWindow) {
            backendContextLine = `  ${pc.dim(`context window ${modelInfo.contextWindow.toLocaleString()}  ·  cache ${displayCacheRead.toLocaleString()} / ${displayCacheWrite.toLocaleString()}`)}`;
          }
        }
      }

      const cacheHit =
        displayInputTokens + displayCacheRead > 0
          ? Math.round(
              (displayCacheRead / (displayInputTokens + displayCacheRead)) *
                100,
            )
          : 0;
      ctx.renderer.writeln(
        `  ${pc.bold("Session")}  ${nameStr}turns ${info.turns}  ·  ${cacheHit}% cache`,
      );
      ctx.renderer.writeln(
        `  ${pc.dim(`in ${displayInputTokens.toLocaleString()}  ·  out ${displayOutputTokens.toLocaleString()} tokens`)}`,
      );
      if (backendModelLine) {
        ctx.renderer.writeln();
        ctx.renderer.writeln(backendModelLine);
        if (backendContextLine) {
          ctx.renderer.writeln(backendContextLine);
        }
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
      const { getAllSessions } = await import("../../storage/sessions.js");
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
          ? (coreResolveModel(s.info.lastModel)?.displayName ?? s.info.lastModel)
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
      const { getSession, setSessionName } =
        await import("../../storage/sessions.js");
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
