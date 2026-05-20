/**
 * Antigravity backend initialisation.
 *
 * Holds onto the Talon config + gateway port + frontend name. Real
 * bridge spawning happens lazily in `ensureBridge(chatId)` from the
 * handler — the cost of starting `localharness` (~1s) only hits the
 * first turn of each chat.
 */

import { resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import type { TalonConfig } from "../../util/config.js";
import type { FrontendName } from "../registry.js";
import { log, logWarn } from "../../util/log.js";
import { getState } from "./state.js";
import { buildAntigravityMcpServers } from "./mcp-config.js";
import { AntigravityBridge } from "./python-bridge.js";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_WORKSPACE_SYMLINK_NAME,
} from "./constants.js";
import { discoverAntigravityModels } from "./discovery.js";

function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

/**
 * Return `true` if any segment of `p` starts with a dot — the rule
 * that `localharness` enforces. We probe this on every workspace
 * path we hand to the bridge so doctor checks + init can refuse a
 * known-bad config explicitly rather than letting the binary reject
 * the agent's start.
 */
function containsHiddenSegment(p: string): boolean {
  return p.split("/").some((seg) => seg !== "" && seg.startsWith("."));
}

/**
 * Resolve the workspace path the Antigravity bridge will hand to
 * localharness, doing whatever symlink dance is necessary so the
 * binary's hidden-segment guard doesn't reject it.
 *
 * Rules:
 *
 *   1. Explicit `antigravityWorkspace` override — used as-is (after
 *      `~` expansion). If it contains hidden segments the operator
 *      gets to deal with the binary's refusal; we just log a warn.
 *   2. No override — we take Talon's REAL workspace (`config.workspace`,
 *      typically `~/.talon/workspace/`) and expose it under
 *      `~/talon-workspace` via a symlink. The agent's read/write hits
 *      the same files every other backend uses. No data fragmentation.
 *   3. Symlink creation is idempotent: if `~/talon-workspace` already
 *      points at `config.workspace`, leave it alone. If it points at
 *      something else, we leave it alone but warn (the operator
 *      created their own symlink — respect it). If it exists as a
 *      regular directory or file, we warn and fall back to the raw
 *      path; localharness will refuse and the operator gets a clear
 *      error in the bridge stderr.
 *
 * Returns the path to pass to localharness (the symlink, or the
 * override).
 */
function resolveWorkspacePath(cfg: TalonConfig): string {
  const cfgRecord = cfg as unknown as Record<string, unknown>;
  const overrideRaw =
    typeof cfgRecord.antigravityWorkspace === "string"
      ? (cfgRecord.antigravityWorkspace as string)
      : undefined;

  if (overrideRaw) {
    const expanded = expandHome(overrideRaw) ?? overrideRaw;
    if (containsHiddenSegment(expanded)) {
      logWarn(
        "agent",
        `Antigravity: antigravityWorkspace=${expanded} contains a hidden ` +
          `path segment. localharness will refuse it. Pick a path with no ` +
          `dot-segments (or leave the field unset to let Talon symlink the ` +
          `main workspace automatically).`,
      );
    }
    ensureDirectory(expanded);
    return expanded;
  }

  // `cfg.workspace` is the Talon-synthesised real workspace path — in
  // production it's always set, but tests may construct a minimal
  // TalonConfig without it. Fall back to the canonical default so the
  // backend still does something reasonable.
  const realWorkspace =
    cfg.workspace ?? resolve(homedir(), ".talon", "workspace");
  if (!containsHiddenSegment(realWorkspace)) {
    // User's main workspace already lives outside a hidden directory —
    // no symlink dance needed.
    ensureDirectory(realWorkspace);
    return realWorkspace;
  }

  // Default flow: symlink ~/talon-workspace → config.workspace so
  // localharness sees a path without hidden segments but the agent
  // operates on the SAME files every other backend touches.
  const symlinkPath = resolve(homedir(), ANTIGRAVITY_WORKSPACE_SYMLINK_NAME);
  ensureSymlink(symlinkPath, realWorkspace);
  return symlinkPath;
}

function ensureDirectory(p: string): void {
  try {
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
  } catch (e) {
    logWarn(
      "agent",
      `Antigravity: failed to ensure directory ${p}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * Idempotently create a symlink at `linkPath` pointing to `target`.
 * If `linkPath` already exists, the behaviour is:
 *
 *   - It's a symlink to the right target → no-op.
 *   - It's a symlink to a DIFFERENT target → warn, leave alone
 *     (operator's choice).
 *   - It exists as a regular file or directory → warn, return; the
 *     caller will pass the literal path and localharness may refuse.
 */
function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (existsSync(linkPath)) {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const current = readlinkSync(linkPath);
        const currentResolved = resolve(
          target.startsWith("/") ? "" : process.cwd(),
          current,
        );
        if (currentResolved === target || current === target) {
          // Already correct.
          return;
        }
        logWarn(
          "agent",
          `Antigravity: symlink ${linkPath} points at ${current}, ` +
            `not ${target}. Leaving alone (delete the symlink to let Talon ` +
            `recreate it).`,
        );
        return;
      }
      logWarn(
        "agent",
        `Antigravity: ${linkPath} exists as a regular file/directory — ` +
          `cannot symlink the Talon workspace through it. Set ` +
          `antigravityWorkspace in talon.json to a path of your choice, ` +
          `or move/remove ${linkPath}.`,
      );
      return;
    }
    // Make sure the target exists before symlinking — otherwise we'd
    // create a dangling link.
    ensureDirectory(target);
    symlinkSync(target, linkPath, "dir");
    log(
      "agent",
      `Antigravity: created workspace symlink ${linkPath} → ${target}`,
    );
  } catch (e) {
    logWarn(
      "agent",
      `Antigravity: failed to ensure symlink ${linkPath} → ${target}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

export function initAntigravityAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: FrontendName,
): void {
  const state = getState();
  state.config = cfg;
  if (getGatewayPort) state.gatewayPortFn = getGatewayPort;
  if (frontend) state.frontendName = frontend;

  const cfgRecord = cfg as unknown as Record<string, unknown>;
  const geminiKey =
    (typeof cfgRecord.geminiApiKey === "string"
      ? (cfgRecord.geminiApiKey as string)
      : undefined) ?? process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    logWarn(
      "agent",
      "Antigravity: no GEMINI_API_KEY env and no geminiApiKey in talon.json. " +
        "First turn will fail with 'API key not valid' until either is set. " +
        "Get a key at https://aistudio.google.com/.",
    );
  } else {
    log("agent", "Antigravity auth: gemini-api-key configured");
  }

  // Provision the workspace path at startup so the doctor + first turn
  // see the symlink immediately, not at first chat.
  resolveWorkspacePath(cfg);

  // Kick off background model discovery so the /model picker is
  // populated with the live catalog before the user opens it. Fire
  // and forget — the discovery module caches the result; the catalog
  // falls back to a curated 5-model list while the call's in flight.
  const pythonPath =
    typeof cfgRecord.antigravityPython === "string"
      ? expandHome(cfgRecord.antigravityPython as string)
      : undefined;
  if (geminiKey) {
    void discoverAntigravityModels({
      apiKey: geminiKey,
      pythonPath,
    }).then((result) => {
      if (result.source === "live") {
        log(
          "agent",
          `Antigravity catalog: ${result.models.length} models discovered live`,
        );
      } else if (result.error) {
        logWarn(
          "agent",
          `Antigravity catalog: using fallback (${result.error})`,
        );
      }
    });
  }
}

export { resolveWorkspacePath, containsHiddenSegment };

/**
 * Lazily start (or reuse) the bridge subprocess for a chat.
 *
 * The bridge is keyed by chat id because Antigravity bakes the MCP
 * server map into the agent context at start time, and our
 * frontend-tools MCP server is chat-scoped. Switching chats means
 * spawning a fresh bridge.
 */
export async function ensureBridge(
  chatId: string,
  modelOverride?: string,
): Promise<AntigravityBridge> {
  const state = getState();
  if (!state.config) {
    throw new Error(
      "Antigravity agent not initialised — call initAntigravityAgent first",
    );
  }

  // Per-chat model override (from /model selection) wins over the
  // global default. `state.config.model` is the chat-role's backend
  // default (e.g. `claude-opus-4-7` when Claude is primary) — sending
  // *that* to Gemini's API yields HTTP 404 `models/claude-opus-4-7
  // is not found`, which is exactly what was happening before this
  // parameter was added.
  const rawModel =
    modelOverride ?? state.config.model ?? ANTIGRAVITY_DEFAULT_MODEL;
  const effectiveModel =
    rawModel === "default" ? ANTIGRAVITY_DEFAULT_MODEL : rawModel;
  // Strip the `models/` prefix Gemini's models.list() includes.
  // `LocalAgentConfig(model=...)` accepts both forms but the short
  // form is what the SDK uses internally — cleaner to send that.
  const bridgeModel = effectiveModel.replace(/^models\//, "");

  // If a bridge is already running for this chat but was started with
  // a different model, kill it and respawn — `LocalAgentConfig.model`
  // is baked at agent-context start, there's no live-swap.
  const existing = state.bridges.get(chatId);
  if (existing && existing.isReady()) {
    if (existing.activeModel === bridgeModel) {
      return existing;
    }
    await existing.shutdown().catch(() => {});
    state.bridges.delete(chatId);
  }

  const bridgeUrl = `http://127.0.0.1:${state.gatewayPortFn()}`;
  const frontends = getActiveFrontends(state.config.frontend);
  const mcpServers = buildAntigravityMcpServers({
    chatId,
    bridgeUrl,
    frontends,
    braveApiKey: state.config.braveApiKey,
  });

  const cfgRecord = state.config as unknown as Record<string, unknown>;
  const geminiKey =
    (typeof cfgRecord.geminiApiKey === "string"
      ? (cfgRecord.geminiApiKey as string)
      : undefined) ?? process.env.GEMINI_API_KEY;

  // Resolve the workspace fresh each time (the bridge may be respawning
  // after a config edit). `resolveWorkspacePath` is idempotent — same
  // symlink, no churn.
  const workspacePath = resolveWorkspacePath(state.config);

  const pythonPath =
    typeof cfgRecord.antigravityPython === "string"
      ? expandHome(cfgRecord.antigravityPython as string)
      : undefined;

  const bridge = new AntigravityBridge(chatId);
  await bridge.start(
    {
      gemini_api_key: geminiKey,
      model: bridgeModel,
      workspaces: [workspacePath],
      mcp_servers: mcpServers,
      // system_instructions is supplied per-turn via the chat prompt
      // (Talon's first-turn prompt rebuild wires the full system
      // suffix in there). We pass `undefined` here so the SDK uses
      // its default — Talon owns the prompt shape.
    },
    {
      pythonPath,
    },
  );

  // If we replaced an existing-but-dead bridge, tear it down.
  if (existing) {
    void existing.shutdown();
  }
  state.bridges.set(chatId, bridge);
  log("agent", `Antigravity bridge ready for chat ${chatId}`);
  return bridge;
}

function getActiveFrontends(
  frontend: TalonConfig["frontend"],
): readonly string[] {
  const all = Array.isArray(frontend) ? frontend : [frontend];
  return all.filter((f) => f !== "terminal");
}
