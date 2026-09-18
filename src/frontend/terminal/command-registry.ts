/**
 * Terminal command registry — the `Command` shape and the name/alias index
 * `tryRunCommand` resolves against.
 */

import type { TalonConfig } from "../../core/config/index.js";
import type { Backend } from "../../core/agent-runtime/capabilities.js";
import type { Renderer } from "./renderer.js";

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

type CommandHandler = (args: string, ctx: CommandContext) => Promise<void>;

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
