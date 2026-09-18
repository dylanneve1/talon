/**
 * Built-in terminal commands, in registration order. The order is what
 * `/help` prints and what `getCommands()` returns, so it is pinned by test.
 */

import type { Command } from "../command-registry.js";
import { modelCommand, effortCommand } from "./model.js";
import { statusCommand } from "./status.js";
import { contextCommand } from "./context.js";
import { resetCommand, resumeCommand, renameCommand } from "./session.js";
import { helpCommand, quitCommand } from "./help.js";

export const BUILTIN_COMMANDS: readonly Command[] = [
  modelCommand,
  effortCommand,
  statusCommand,
  contextCommand,
  resetCommand,
  resumeCommand,
  renameCommand,
  helpCommand,
  quitCommand,
];
