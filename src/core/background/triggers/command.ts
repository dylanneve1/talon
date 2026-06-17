/**
 * Interpreter resolution for trigger scripts. Shared with the scripts runner
 * (core/scripts/runner.ts) — scripts use the bash/python/node subset. Returns
 * null when no interpreter is available (currently only bash on Windows).
 */

import { spawnSync } from "node:child_process";
import type { Trigger } from "../../../storage/trigger-store.js";
import { selfInvocation } from "../../../util/mcp-launcher.js";
import { LUA_RUN_SUBCOMMAND } from "../../scripting/lua-runner.js";

export function commandForLanguage(
  lang: Trigger["language"],
): { cmd: string; args: string[] } | null {
  switch (lang) {
    case "bash":
      return commandForBash();
    case "python":
      return {
        cmd: process.platform === "win32" ? "python" : "python3",
        args: [],
      };
    case "node":
      return { cmd: "node", args: [] };
    case "lua": {
      // Lua has no host interpreter dependency: Talon re-invokes its own
      // entrypoint with the `_lua-run` subcommand (same self-invocation shape
      // as MCP supervision) and runs the script in a WASM-sandboxed wasmoon VM.
      const inv = selfInvocation(LUA_RUN_SUBCOMMAND);
      return { cmd: inv.command, args: inv.args };
    }
  }
}

let _bashCommand: { cmd: string; args: string[] } | null | undefined =
  undefined;

function commandForBash(): { cmd: string; args: string[] } | null {
  if (_bashCommand !== undefined) return _bashCommand;
  const candidates =
    process.platform === "win32"
      ? [
          "bash",
          "C:\\Program Files\\Git\\bin\\bash.exe",
          "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        ]
      : ["bash"];
  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["-lc", "exit 0"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (probe.status === 0) {
      _bashCommand = { cmd, args: [] };
      return _bashCommand;
    }
  }
  _bashCommand = null;
  return null;
}
