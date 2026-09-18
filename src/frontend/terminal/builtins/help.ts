/** `/help` and `/quit` — the registry's own commands. */

import pc from "picocolors";
import { getCommands, type Command } from "../command-registry.js";

export const helpCommand: Command = {
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
};

export const quitCommand: Command = {
  name: "quit",
  aliases: ["exit"],
  description: "Exit",
  async handler(_args, ctx) {
    ctx.close();
  },
};
