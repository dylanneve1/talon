/**
 * Talon entry shim.
 *
 * Dispatches the hidden `_mcp-launch` supervisor subcommand BEFORE the
 * app graph loads (see util/mcp-launcher.ts — Talon supervises its MCP
 * stdio children by re-invoking itself). The dynamic import keeps
 * supervisor processes light: they evaluate this shim and the
 * supervisor module, never the backends/frontends/plugins.
 */

import { MCP_LAUNCH_SUBCOMMAND, runSupervisor } from "./util/mcp-launcher.js";

if (process.argv[2] === MCP_LAUNCH_SUBCOMMAND) {
  await runSupervisor(process.argv.slice(3));
} else {
  await import("./app.js");
}
