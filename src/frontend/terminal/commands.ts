/**
 * Terminal command registry — extensible slash command system.
 *
 * Each command is a self-contained handler registered via `registerCommand()`.
 * New commands = one function call. Handlers are independently testable.
 * The builtins live one module per group under `./builtins/`.
 */

import { registerCommand } from "./command-registry.js";
import { BUILTIN_COMMANDS } from "./builtins/index.js";

export {
  registerCommand,
  tryRunCommand,
  getCommands,
  clearCommands,
  type CommandContext,
} from "./command-registry.js";

// ── Built-in commands ────────────────────────────────────────────────────────

export function registerBuiltinCommands(): void {
  for (const cmd of BUILTIN_COMMANDS) registerCommand(cmd);
}
