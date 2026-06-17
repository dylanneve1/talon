#!/usr/bin/env node
/**
 * Talon CLI entry point.
 *
 * Usage:
 *   talon              — interactive menu (runs setup on first launch)
 *   talon setup        — guided setup wizard
 *   talon status       — show bot health and stats
 *   talon config       — view/edit configuration
 *   talon logs         — tail the log file with formatting
 *   talon start        — start the bot directly
 *   talon chat         — terminal chat mode
 *
 * This file stays intentionally thin: it handles the must-run-first hidden
 * subcommand dispatch (below), then hands off to the command router in
 * `cli/index.ts`. Everything else lives under `cli/`.
 */

import { MCP_LAUNCH_SUBCOMMAND, runSupervisor } from "./util/mcp-launcher.js";
import { LUA_RUN_SUBCOMMAND, runLuaMain } from "./core/scripting/lua-runner.js";

// Hidden subcommand dispatch — must run before anything else. Talon
// supervises MCP stdio children (`_mcp-launch`) and runs WASM-sandboxed
// Lua trigger scripts (`_lua-run`) by re-invoking its own entrypoint
// (see util/mcp-launcher.ts). Neither call resolves; the helper process
// exits from its own handlers.
if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
  await runSupervisor(process.argv.slice(3));
} else if (process.argv[2] === LUA_RUN_SUBCOMMAND) {
  await runLuaMain(process.argv.slice(3));
} else {
  const { runCli } = await import("./cli/index.js");
  await runCli();
}
