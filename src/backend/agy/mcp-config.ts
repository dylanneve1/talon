/**
 * Manage the MCP server entries in `~/.gemini/config/mcp_config.json`
 * so agy spawns the same plugin servers Talon's other backends use.
 *
 * Constraints:
 *
 *   - agy reads `mcp_config.json` from a **hardcoded** path under
 *     `~/.gemini/config/` (no `XDG_CONFIG_HOME` redirect, no per-spawn
 *     override flag). We can't put a Talon-private copy elsewhere.
 *   - The user may have their own MCP servers configured there for
 *     their interactive `agy` sessions; we must not clobber them.
 *   - agy's MCP config is **global**, so per-chat env vars
 *     (`TALON_CHAT_ID`) have to be re-stamped right before each
 *     `agy --print` spawn. The handler acquires a process-wide lock,
 *     calls `installMcpConfigForChat(chatId)`, spawns agy, then
 *     releases. agy turns are serialised globally across chats by
 *     this lock — fine because each turn is only a few seconds.
 *
 * The MCP entries Talon adds carry a `__talon__` marker prefix so
 * removal is deterministic: drop every key starting with the marker,
 * write back, leave everything else untouched.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import writeFileAtomic from "write-file-atomic";
import { log, logError, logWarn } from "../../util/log.js";
import { wrapMcpCommand } from "../../util/mcp-launcher.js";
import { getPluginMcpServers } from "../../core/plugin.js";

/** Path agy hardcodes for its MCP server config. */
const MCP_CONFIG_PATH = resolve(
  homedir(),
  ".gemini/config/mcp_config.json",
);

/**
 * Marker we tag Talon-owned entries with so `installMcpConfigForChat`
 * can clean up its previous run without scanning command lines. Picked
 * to be obviously Talon-namespaced so a user reading their config
 * understands what's going on.
 */
const TALON_MARKER = "__talon__";

interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [extra: string]: unknown;
}

function readCurrentConfig(): McpConfigFile {
  try {
    if (!existsSync(MCP_CONFIG_PATH)) return {};
    const raw = readFileSync(MCP_CONFIG_PATH, "utf-8").trim();
    if (raw.length === 0) return {};
    return JSON.parse(raw) as McpConfigFile;
  } catch (err) {
    // Treat unreadable / corrupt config as empty — agy already logs
    // `unexpected end of JSON input` for those, so we're not hiding
    // anything by overwriting. The user can recover their entries
    // from backup if needed.
    logWarn(
      "agent",
      `agy: mcp_config.json unreadable (${
        err instanceof Error ? err.message : String(err)
      }) — treating as empty`,
    );
    return {};
  }
}

function writeConfig(cfg: McpConfigFile): void {
  try {
    const dir = dirname(MCP_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Stable, human-editable formatting so users who look at the
    // file see something readable.
    writeFileAtomic.sync(
      MCP_CONFIG_PATH,
      JSON.stringify(cfg, null, 2) + "\n",
    );
  } catch (err) {
    logError(
      "agent",
      `agy: failed to write mcp_config.json — agy will not see Talon's MCP servers`,
      err,
    );
  }
}

/** Strip all Talon-owned entries from a parsed config object. */
function stripTalonEntries(cfg: McpConfigFile): McpConfigFile {
  if (!cfg.mcpServers) return cfg;
  const next: Record<string, McpServerEntry> = {};
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    if (!name.startsWith(TALON_MARKER)) next[name] = server;
  }
  return { ...cfg, mcpServers: next };
}

/**
 * Build the Talon-owned MCP entries for `chatId`. Mirrors the antigravity
 * backend's `buildAntigravityMcpServers` shape so the resulting agy
 * config wires the same plugin set: frontend-tools (telegram-tools or
 * whatever the active frontend is) + brave-search (if configured) +
 * every loaded plugin's MCP servers.
 *
 * Each entry is keyed `__talon__<server-name>` so:
 *
 *   - `stripTalonEntries` can wipe Talon's set cleanly without touching
 *     entries the user added,
 *   - the user reading the file sees which entries are Talon-managed.
 *
 * `bridgeUrl` should be the action gateway endpoint
 * (`http://127.0.0.1:<port>`). `frontends` is the list of non-terminal
 * frontends currently running — empty for terminal-only deployments.
 */
export function buildAgyMcpEntries(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
}): Record<string, McpServerEntry> {
  const { chatId, bridgeUrl, frontends, braveApiKey } = args;

  const out: Record<string, McpServerEntry> = {};

  const baseEnv = {
    TALON_BRIDGE_URL: bridgeUrl,
    TALON_CHAT_ID: chatId,
  };

  // Frontend-tools server per active frontend. Same MCP server as every
  // other backend uses; the launcher injects the env + supervises the
  // stdio child.
  const mcpServerPath = resolve(
    new URL("../../core/tools/mcp-server.ts", import.meta.url).pathname,
  );
  const tsxImport = resolve(
    new URL("../../../node_modules/tsx/dist/esm/index.mjs", import.meta.url)
      .pathname,
  );
  for (const frontend of frontends) {
    const wrapped = wrapMcpCommand([
      "node",
      "--import",
      tsxImport,
      mcpServerPath,
    ]);
    out[`${TALON_MARKER}${frontend}-tools`] = {
      command: wrapped[0],
      args: wrapped.slice(1),
      env: { ...baseEnv, TALON_FRONTEND: frontend },
    };
  }

  if (braveApiKey) {
    out[`${TALON_MARKER}brave-search`] = {
      command: resolve(
        new URL(
          "../../../node_modules/.bin/brave-search-mcp-server",
          import.meta.url,
        ).pathname,
      ),
      args: [],
      env: { BRAVE_API_KEY: braveApiKey },
    };
  }

  // `getPluginMcpServers` already returns commands wrapped through
  // `mcp-launcher.mjs` — wrapping again here would put two launcher
  // hops in front of the real plugin (e.g. playwright was launching
  // as `node ↪ launcher ↪ node ↪ launcher ↪ node ↪ playwright`, which
  // both added startup latency and broke agy's protocol handshake on
  // the slower plugins). Pass plugin entries through unchanged.
  const pluginServers = getPluginMcpServers(bridgeUrl, chatId);
  for (const [name, cfg] of Object.entries(pluginServers)) {
    out[`${TALON_MARKER}${name}`] = {
      command: cfg.command,
      args: [...cfg.args],
      env: cfg.env ?? {},
    };
  }

  return out;
}

/**
 * Install Talon's MCP entries into agy's global config for `chatId`,
 * preserving any non-Talon entries the user has there. Idempotent —
 * each call drops the previous Talon set before adding the fresh one,
 * so changing chats just rewrites the `TALON_CHAT_ID` env on the
 * frontend-tools entry.
 */
export function installMcpConfigForChat(args: {
  chatId: string;
  bridgeUrl: string;
  frontends: readonly string[];
  braveApiKey?: string;
}): void {
  const current = stripTalonEntries(readCurrentConfig());
  const next: McpConfigFile = {
    ...current,
    mcpServers: {
      ...(current.mcpServers ?? {}),
      ...buildAgyMcpEntries(args),
    },
  };
  writeConfig(next);
  log(
    "agent",
    `agy: installed Talon MCP entries for chat ${args.chatId} ` +
      `(${Object.keys(next.mcpServers ?? {}).length} servers total)`,
  );
}

/**
 * Strip all `__talon__` entries from agy's config. Called on factory
 * cleanup so a Talon shutdown leaves the file in the same shape the
 * user had it in before — user-added entries preserved, Talon-added
 * entries gone.
 */
export function uninstallMcpConfig(): void {
  const stripped = stripTalonEntries(readCurrentConfig());
  writeConfig(stripped);
  log("agent", "agy: uninstalled Talon MCP entries from agy config");
}
