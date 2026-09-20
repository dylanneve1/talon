/**
 * Talon entry shim.
 *
 * Dispatches the hidden `_mcp-launch` (MCP supervisor), `_lua-run`
 * (WASM Lua trigger runner) and `_handoff-watch` (restart/update
 * witness) subcommands BEFORE the app graph loads — all three are Talon
 * re-invoking itself (see core/mcp-hub/launcher.ts, core/daemon/
 * handoff.ts). The dynamic import keeps these helper processes light:
 * they evaluate this shim and their own module, never the
 * backends/frontends/plugins.
 */

import { installSignalListenerGuard } from "./core/daemon/signals.js";
import {
  MCP_LAUNCH_SUBCOMMAND,
  runSupervisor,
} from "./core/mcp-hub/launcher.js";
import { LUA_RUN_SUBCOMMAND, runLuaMain } from "./core/scripts/lua.js";
import {
  HANDOFF_WATCH_SUBCOMMAND,
  runHandoffWatch,
} from "./core/daemon/handoff.js";

// Before anything can remove a signal listener: under Bun that would
// silently disarm SIGTERM/SIGINT for the whole process (core/daemon/
// signals.ts). Every Talon process passes through here, so every one
// is covered.
installSignalListenerGuard();

if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
  await runSupervisor(process.argv.slice(3));
} else if (process.argv[2] === LUA_RUN_SUBCOMMAND) {
  await runLuaMain(process.argv.slice(3));
} else if (process.argv[2] === HANDOFF_WATCH_SUBCOMMAND) {
  await runHandoffWatch(process.argv.slice(3));
} else {
  await import("./app.js");
}
