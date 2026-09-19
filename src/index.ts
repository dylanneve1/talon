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

import {
  MCP_LAUNCH_SUBCOMMAND,
  runSupervisor,
} from "./core/mcp-hub/launcher.js";
import { LUA_RUN_SUBCOMMAND, runLuaMain } from "./core/scripts/lua.js";
import {
  HANDOFF_WATCH_SUBCOMMAND,
  runHandoffWatch,
} from "./core/daemon/handoff.js";

if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
  await runSupervisor(process.argv.slice(3));
} else if (process.argv[2] === LUA_RUN_SUBCOMMAND) {
  await runLuaMain(process.argv.slice(3));
} else if (process.argv[2] === HANDOFF_WATCH_SUBCOMMAND) {
  await runHandoffWatch(process.argv.slice(3));
} else {
  await import("./app.js");
}
