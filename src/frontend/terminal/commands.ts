/**
 * Terminal command registry — extensible slash command system.
 *
 * Each command is a self-contained handler registered via `registerCommand()`.
 * New commands = one function call. Handlers are independently testable.
 */

import pc from "picocolors";
import type { TalonConfig } from "../../util/config.js";
import type { Renderer } from "./renderer.js";
import { formatTimeAgo } from "./renderer.js";
import { isTerminalChatId } from "../../util/chat-id.js";

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
    description: "Switch model (opus, sonnet, haiku)",
    async handler(args, ctx) {
      const {
        getChatSettings,
        setChatModel,
        resolveModelName,
      } = await import("../../storage/chat-settings.js");
      if (!args) {
        ctx.renderer.writeSystem(
          `Model: ${getChatSettings(ctx.chatId()).model ?? ctx.config.model}`,
        );
      } else {
        setChatModel(ctx.chatId(), resolveModelName(args));
        ctx.renderer.writeSystem(`Model → ${resolveModelName(args)}`);
      }
      ctx.reprompt();
    },
  });

  registerCommand({
    name: "effort",
    argHint: "[lvl]",
    description: "Thinking effort (off/low/medium/high/max)",
    async handler(args, ctx) {
      const { getChatSettings, setChatEffort } = await import(
        "../../storage/chat-settings.js"
      );
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
      const { getLoadedPlugins } = await import("../../core/plugin.js");
      const info = getSessionInfo(ctx.chatId());
      const u = info.usage;
      const cacheHit =
        u.totalInputTokens + u.totalCacheRead > 0
          ? Math.round(
              (u.totalCacheRead / (u.totalInputTokens + u.totalCacheRead)) *
                100,
            )
          : 0;
      ctx.renderer.writeln();
      const nameStr = info.sessionName ? `"${info.sessionName}"  ·  ` : "";
      ctx.renderer.writeln(
        `  ${pc.bold("Session")}  ${nameStr}turns ${info.turns}  ·  ${cacheHit}% cache`,
      );
      ctx.renderer.writeln(
        `  ${pc.dim(`in ${u.totalInputTokens.toLocaleString()}  ·  out ${u.totalOutputTokens.toLocaleString()} tokens`)}`,
      );
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
          ? s.info.lastModel
              .replace("claude-", "")
              .replace(/-(\d+)-(\d+).*/, " $1.$2")
          : "";
        ctx.renderer.writeln(
          `  ${pc.green(String(i + 1))}. ${name}  ${pc.dim(`${turns}  ·  ${ago}${model ? `  ·  ${model}` : ""}`)}`,
        );
      }
      ctx.renderer.writeln();
      ctx.renderer.writeln(
        `  ${pc.dim("Enter number to resume (or Enter to cancel):")}`,
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
      const { getSessionInfo, setSessionName } = await import(
        "../../storage/sessions.js"
      );
      if (!args) {
        const info = getSessionInfo(ctx.chatId());
        ctx.renderer.writeSystem(
          info.sessionName
            ? `Session name: "${info.sessionName}"`
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
        const pad = " ".repeat(Math.max(1, 16 - nameStr.length - argStr.length));
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
