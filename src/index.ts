/**
 * Talon entry shim.
 *
 * Dispatches the hidden `_mcp-launch` (MCP supervisor) and `_lua-run`
 * (WASM Lua trigger runner) subcommands BEFORE the app graph loads —
 * both are Talon re-invoking itself (see util/mcp-launcher.ts). The
 * dynamic import keeps these helper processes light: they evaluate this
 * shim and their own module, never the backends/frontends/plugins.
 */

import { MCP_LAUNCH_SUBCOMMAND, runSupervisor } from "./util/mcp-launcher.js";
import { LUA_RUN_SUBCOMMAND, runLuaMain } from "./core/scripting/lua-runner.js";

if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
  await runSupervisor(process.argv.slice(3));
} else if (process.argv[2] === LUA_RUN_SUBCOMMAND) {
  await runLuaMain(process.argv.slice(3));
} else {
  await import("./app.js");
}
