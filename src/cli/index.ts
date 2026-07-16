/**
 * Talon CLI — interactive setup, management, and monitoring.
 *
 * The entry point (`src/cli.ts`) handles the must-run-first hidden subcommand
 * dispatch, then delegates to `runCli()` here. Each user-facing command lives
 * in its own module:
 *
 *   - `config`      — config model + load/save/format + banner
 *   - `setup`       — guided setup wizard
 *   - `status`      — health / stats summary
 *   - `config-view` — print + edit configuration
 *   - `logs`        — tail the log file
 *   - `doctor`      — environment + native-module checks
 *   - `chat`        — terminal chat mode
 *   - `daemon`      — start/stop/restart outcome rendering
 *   - `menu`        — interactive main menu (no-subcommand default)
 */

import pc from "picocolors";
// Imported (not read from disk) so `--version` works in a standalone
// `bun build --compile` binary, which has no package.json on disk — bun
// inlines the JSON at compile time; tsx/node resolve it from the package.
import pkg from "../../package.json" with { type: "json" };
import { PKG_ROOT } from "./context.js";
import { printBanner } from "./config.js";
import { runSetup } from "./setup.js";
import { showStatus } from "./status.js";
import { viewConfig } from "./config-view.js";
import { tailLogs } from "./logs.js";
import { runDoctor } from "./doctor.js";
import { startChat } from "./chat.js";
import { daemonStart, daemonStop, daemonRestart } from "./daemon.js";
import { showTasks, killTask } from "./tasks.js";
import { showEvents } from "./events.js";
import { mainMenu } from "./menu.js";

export * from "./context.js";
export * from "./config.js";
export { runSetup } from "./setup.js";
export { showStatus, formatUptime } from "./status.js";
export { viewConfig } from "./config-view.js";
export { tailLogs, formatLogLine } from "./logs.js";
export { runDoctor } from "./doctor.js";
export { startChat } from "./chat.js";
export { daemonStart, daemonStop, daemonRestart } from "./daemon.js";
export { mainMenu } from "./menu.js";

/** Every dispatchable subcommand — the unknown-command suggester's vocabulary. */
const CLI_COMMANDS = [
  "setup",
  "status",
  "config",
  "logs",
  "start",
  "stop",
  "restart",
  "run",
  "chat",
  "doctor",
  "ps",
  "kill",
  "events",
];

/** Route a `talon <command>` invocation. Called by the entry point. */
export async function runCli(): Promise<void> {
  const command = process.argv[2];
  switch (command) {
    case "setup":
      runSetup();
      break;
    case "status":
      showStatus();
      break;
    case "config":
      viewConfig();
      break;
    case "logs":
      tailLogs();
      break;
    case "start":
      printBanner();
      await daemonStart();
      break;
    case "stop":
      printBanner();
      await daemonStop();
      break;
    case "restart":
      printBanner();
      await daemonRestart();
      break;
    case "run":
      process.chdir(PKG_ROOT);
      import("../index.js");
      break;
    case "chat":
      process.chdir(PKG_ROOT);
      startChat();
      break;
    case "doctor":
      runDoctor();
      break;
    case "ps":
      await showTasks();
      break;
    case "kill":
      await killTask(process.argv[3]);
      break;
    case "events":
      await showEvents(
        process.argv[3] === "-f" || process.argv[3] === "--follow",
      );
      break;
    case "--version":
    case "-v": {
      console.log(pkg.version);
      break;
    }
    case "--help":
    case "-h":
      printBanner();
      console.log("  Usage: talon [command]\n");
      console.log("  Commands:");
      console.log(`    ${pc.cyan("setup")}      Guided setup wizard`);
      console.log(`    ${pc.cyan("start")}      Start as background daemon`);
      console.log(`    ${pc.cyan("stop")}       Stop the daemon`);
      console.log(`    ${pc.cyan("restart")}    Restart the daemon`);
      console.log(`    ${pc.cyan("run")}        Run in foreground (attached)`);
      console.log(`    ${pc.cyan("chat")}       Terminal chat mode`);
      console.log(`    ${pc.cyan("status")}     Show bot health`);
      console.log(`    ${pc.cyan("ps")}         List agent tasks (task table)`);
      console.log(`    ${pc.cyan("kill")}       Abort a killable task by id`);
      console.log(
        `    ${pc.cyan("events")}     Tail the event bus (-f follows)`,
      );
      console.log(`    ${pc.cyan("config")}     View/edit configuration`);
      console.log(`    ${pc.cyan("logs")}       Tail log file`);
      console.log(`    ${pc.cyan("doctor")}     Validate environment`);
      console.log(`    ${pc.cyan("--version")}  Print the package version`);
      console.log();
      console.log(
        `  Run ${pc.cyan("talon")} with no args for interactive menu.\n`,
      );
      break;
    case undefined:
      mainMenu();
      break;
    default: {
      // "did you mean ...?" via the C similarity core (native/strsim-c).
      const { closestMatch } = await import("../native/strsim.js");
      const suggestion = closestMatch(command, CLI_COMMANDS);
      const hint = suggestion
        ? `Did you mean ${pc.cyan(`talon ${suggestion.value}`)}?`
        : `Run ${pc.cyan("talon --help")} for usage.`;
      console.error(`  Unknown command: ${command}\n  ${hint}\n`);
      process.exit(1);
    }
  }
}
