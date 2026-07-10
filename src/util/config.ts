import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { dirs, files as pathFiles } from "./paths.js";
import { setTimezone } from "./time.js";
import { BACKEND_IDS } from "../core/agent-runtime/model-ref.js";
import {
  assembleSystemPrompt,
  joinSystemPromptParts,
  type SystemPromptParts,
} from "../core/prompt/assemble.js";

/**
 * Backend-id literal source.
 *
 * `BACKEND_IDS` lives in `core/agent-runtime/model-ref.ts` as the
 * source of truth for the typed `BackendId` union. Reusing it
 * here keeps the config zod enums in lockstep automatically —
 * adding a backend means updating one literal, not five.
 *
 * `z.enum` wants a non-empty readonly tuple; spread `BACKEND_IDS`
 * (declared `as const`) into a fresh array and assert the tuple
 * shape `[string, ...string[]]` so zod is happy at compile time.
 */
const BACKEND_ID_ENUM = [...BACKEND_IDS] as [
  (typeof BACKEND_IDS)[number],
  ...(typeof BACKEND_IDS)[number][],
];

// ── Config schema ───────────────────────────────────────────────────────────

/** Path-based Talon plugin (loaded as a Node module). */
const pluginPathSchema = z
  .object({
    path: z.string(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Standalone MCP server (command + args, not a Talon plugin module). */
const pluginMcpSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const pluginEntrySchema = z
  .object({
    path: z.string().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasPath = value.path !== undefined;
    const hasMcpFields =
      value.name !== undefined ||
      value.command !== undefined ||
      value.args !== undefined ||
      value.env !== undefined;

    if (hasPath && hasMcpFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Plugin entry must use exactly one format: either 'path' (with optional 'config') or MCP fields ('name', 'command', optional 'args'/'env'), but not both.",
      });
      return;
    }

    if (!hasPath && !hasMcpFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Plugin entry must provide either 'path' or both 'name' and 'command'.",
      });
      return;
    }

    if (hasMcpFields) {
      if (value.config !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["config"],
          message: "MCP plugin entries cannot include 'config'.",
        });
      }

      if (value.name === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["name"],
          message: "MCP plugin entries must include 'name'.",
        });
      }

      if (value.command === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["command"],
          message: "MCP plugin entries must include 'command'.",
        });
      }

      return;
    }
  })
  .pipe(z.union([pluginPathSchema, pluginMcpSchema]));

const frontendEnum = z.enum([
  "telegram",
  "terminal",
  "teams",
  "discord",
  "native",
]);

/**
 * Native frontend — a client-agnostic bridge (HTTP + Server-Sent Events,
 * JSON) that GUI clients connect to: the bundled Electron companion app
 * (apps/desktop), and any future client (Android, web, …) speaking the
 * same versioned protocol against `host:port`.
 *
 * Defaults are loopback-only and unauthenticated (single-machine use). To
 * reach Talon remotely, set `host: "0.0.0.0"` and a `token` — the bridge
 * then requires `Authorization: Bearer <token>` (or `?token=` for SSE).
 */
const nativeConfigSchema = z
  .object({
    /** Port the bridge binds. Falls back +1..+5 on EADDRINUSE. */
    port: z.number().int().min(1024).max(65535).default(19880),
    /**
     * Interface to bind. `127.0.0.1` (default) is local-only; `0.0.0.0`
     * exposes the bridge on the LAN for remote clients — only do this with
     * a `token` set.
     */
    host: z.string().default("127.0.0.1"),
    /**
     * Optional shared secret. When set, every request must present it as a
     * bearer token (header) or `?token=` query param (SSE). Required in
     * practice whenever `host` is not loopback.
     */
    token: z.string().optional(),
  })
  .strict();

const discordConfigSchema = z
  .object({
    /** Discord bot token (from https://discord.com/developers/applications). */
    botToken: z.string(),
    /**
     * Discord application (client) ID. Found on the same Developer Portal
     * page as the bot token. Required for slash-command registration via
     * `Routes.applicationCommands(...)`.
     */
    applicationId: z.string(),
    /** User IDs allowed to DM the bot. Empty array disables DM access. */
    allowedUsers: z.array(z.string()).default([]),
    /** Guild IDs the bot is permitted to operate in. */
    allowedGuilds: z.array(z.string()).default([]),
    /** Optional channel ID allowlist within `allowedGuilds`. Empty = all channels. */
    allowedChannels: z.array(z.string()).default([]),
    /** User IDs with /admin command access. */
    adminUserIds: z.array(z.string()).default([]),
    /**
     * In guilds, when does the bot reply?
     *   - "mention"  reply only when @mentioned or in a reply chain (default)
     *   - "channel"  reply to every message in allowedChannels
     */
    respondMode: z.enum(["mention", "channel"]).default("mention"),
    /** Auto-leave guilds not on `allowedGuilds`. */
    leaveUnauthorizedGuilds: z.boolean().default(true),
    /** Custom status text shown under the bot's name. */
    presence: z.string().optional(),
    /** Enable global slash command + DM command registration. */
    enableDmCommands: z.boolean().default(true),
  })
  .strict();

const playwrightConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Browser engine: chromium (default), chrome, firefox, webkit, msedge */
  browser: z.string().optional(),
  /** Run headless (default: true) */
  headless: z.boolean().default(true),
  /** Connect to an existing browser websocket endpoint. */
  endpoint: z.string().optional(),
  /** Read the browser websocket endpoint from a file. */
  endpointFile: z.string().optional(),
});

/** MemPalace backend settings, shared by `memory.mempalace` and the legacy top-level `mempalace` section. */
const mempalaceSettingsSchema = z.object({
  /** Palace directory path (default: ~/.talon/workspace/palace/) */
  palacePath: z.string().min(1).optional(),
  /** Python binary path (default: ~/.talon/mempalace-venv/bin/python) */
  pythonPath: z.string().min(1).optional(),
  /**
   * BCP 47 language codes for entity detection (mempalace >= 3.3).
   * Supported: en, es, fr, de, ja, ko, zh-CN, zh-TW, pt-br, ru, it, hi, id.
   * Sets MEMPALACE_ENTITY_LANGUAGES for the MCP server.
   */
  entityLanguages: z.array(z.string().min(2)).nonempty().optional(),
  /** Enable mempalace diagnostic diaries (sets MEMPAL_VERBOSE=1). */
  verbose: z.boolean().optional(),
});

/** mem0 backend settings, shared by `memory.mem0` and the top-level `mem0` section. */
const mem0SettingsSchema = z.object({
  /** Platform API key (default: MEM0_API_KEY env var). */
  apiKey: z.string().min(1).optional(),
  /** Self-hosted mem0 server URL; when set, apiKey may be omitted. */
  host: z.string().min(1).optional(),
  /** Entity id memories are filed under (default "talon"). */
  userId: z.string().min(1).optional(),
});

/**
 * Memory pre-retrieval (Phase B) — automatic per-turn palace retrieval.
 * Ships INERT: the flag gates wiring a real retriever into the dispatcher.
 * With `enabled: false` (default) prompts are byte-identical to previous
 * behavior. See docs in core/memory/retrieval.ts for the trust policy.
 */
const memoryPreRetrievalSchema = z.object({
  /** Master switch. Default off — plumbing merges disabled. */
  enabled: z.boolean().default(false),
  /** Maximum retrieved items injected per turn. */
  maxResults: z.number().int().min(1).max(10).default(3),
  /** Hard cap on injected characters, provenance labels included. */
  maxChars: z.number().int().min(200).max(20000).default(3000),
  /** In groups, filter private-user drawers before injection. */
  groupPrivateUserFiltering: z.boolean().default(true),
});

const configSchema = z.object({
  frontend: z.union([frontendEnum, z.array(frontendEnum)]).default("telegram"),
  botToken: z.string().optional(),
  backend: z.enum(BACKEND_ID_ENUM).default("claude"),
  /**
   * Backend used by the heartbeat agent. Falls back to `backend` when
   * unset. Pair with `heartbeatModel` — the heartbeat agent reads the
   * model field against the heartbeat backend's catalog. Useful for
   * keeping heartbeats on Claude Sonnet for quality while chat runs
   * on a cheaper / free backend.
   */
  heartbeatBackend: z.enum(BACKEND_ID_ENUM).optional(),
  /**
   * Backend used by the dream / memory-consolidation agent. Falls
   * back to `backend` when unset. Pair with `dreamModel`.
   */
  dreamBackend: z.enum(BACKEND_ID_ENUM).optional(),
  /**
   * Whitelist of backends surfaced in the `/model` picker's backend
   * submenu. Unset → every registered backend is offered. Set →
   * only the listed ids appear (useful when you want to hide
   * kilo / opencode in favour of openai-agents + claude).
   *
   * NOTE: persisted per-chat backend overrides are reconciled against this
   * list on restart. If a chat was pinned to a backend that is no longer
   * enabled, Talon clears that chat's backend/model override and starts a
   * fresh default session.
   */
  enabledBackends: z.array(z.enum(BACKEND_ID_ENUM)).optional(),
  claudeBinary: z.string().optional(),
  /**
   * Override the path to the `codex` executable the Codex backend spawns
   * (passed through to the codex-sdk's `codexPathOverride`). Mirrors
   * `claudeBinary`. Primarily for functional tests that point Codex at a
   * stub binary; also accepts the `TALON_CODEX_BINARY` env var. When
   * unset, the codex-sdk resolves `codex` from its package / PATH.
   */
  codexBinary: z.string().optional(),
  model: z.string().default("default"),
  /**
   * Per-backend default model overrides. Keyed by backend id
   * (`"claude"`, `"codex"`, `"openai-agents"`, etc). When a chat has no
   * per-chat model picked for backend X and X has no canonical default
   * (catalog-driven backends like OpenAI Agents pointed at OpenRouter,
   * Kilo, OpenCode), Talon falls through to `backendDefaults[X]` before
   * surfacing "no model selected" to the user.
   *
   * Example:
   *   "backendDefaults": {
   *     "openai-agents": "meta-llama/llama-3.3-70b-instruct:free",
   *     "kilo": "kilo/deepseek/deepseek-v4-flash:free"
   *   }
   *
   * Operator-controlled escape hatch for first-message-on-a-fresh-backend
   * UX — backends with a canonical `getDefaultModel()` (Claude SDK, Codex,
   * stock OpenAI Agents) don't need an entry here.
   */
  backendDefaults: z.record(z.string(), z.string()).optional(),
  dreamModel: z.string().optional(), // Model used for background memory consolidation (defaults to main model)
  maxMessageLength: z.number().int().min(100).default(4000),
  concurrency: z.number().int().min(1).max(20).default(1),
  apiId: z.number().int().optional(),
  apiHash: z.string().optional(),
  adminUserId: z.number().int().optional(),
  allowedUsers: z.array(z.number().int()).optional(), // Whitelist of user IDs allowed to DM the bot
  pulse: z.boolean().default(true),
  pulseIntervalMs: z.number().int().min(60000).default(300000),
  /** Background memory-consolidation (dream) runs. Mirrors `pulse`/`heartbeat`. */
  dream: z.boolean().default(true),
  /** Memory pre-retrieval (Phase B). Optional; absent = disabled. */
  memoryPreRetrieval: memoryPreRetrievalSchema.optional(),
  /**
   * Periodic background agent (default: on, hourly). Advances open
   * goals, runs user-defined maintenance, and proactively messages
   * chats when something worth knowing comes up. Disable with
   * `"heartbeat": false`; requires a backend with the background
   * capability.
   */
  heartbeat: z.boolean().default(true),
  heartbeatIntervalMinutes: z.number().int().min(5).default(60),
  heartbeatModel: z.string().optional(), // Model for heartbeat agent (defaults to main model)
  braveApiKey: z.string().optional(),
  /**
   * Codex-specific OpenAI API key. Prefer this, CODEX_API_KEY, or
   * TALON_CODEX_KEY when the Codex backend should use API-key billing
   * instead of `codex login` ChatGPT OAuth. This key is passed only to
   * Codex.
   */
  codexApiKey: z.string().optional(),
  /**
   * OpenAI API key — used by the OpenAI Agents backend and accepted by
   * Codex only as a last-resort legacy fallback when no Codex-specific
   * key and no `codex login` auth file are available. Falls back to
   * OPENAI_API_KEY env. For OpenAI-compatible endpoints used by the
   * OpenAI Agents backend (OpenRouter, Azure, Ollama, custom proxy),
   * set this to the endpoint's key and configure `openaiBaseUrl` below.
   */
  openaiApiKey: z.string().optional(),
  /**
   * Base URL for an OpenAI-compatible API endpoint, used by the
   * `openai-agents` backend. When unset, the SDK targets OpenAI's
   * production API. Set this to redirect at any OpenAI-compatible
   * service — examples:
   *   - OpenRouter:  https://openrouter.ai/api/v1
   *   - Azure:       https://<resource>.openai.azure.com/openai/v1
   *   - Ollama:      http://localhost:11434/v1
   *   - LiteLLM/etc: http://localhost:4000/v1
   *
   * Falls back to OPENAI_BASE_URL env. Most third-party endpoints
   * implement Chat Completions but not Responses — see `openaiApiMode`.
   */
  openaiBaseUrl: z.string().url().optional(),
  /**
   * Which OpenAI API surface the `openai-agents` backend should target.
   *   - "responses"        — Responses API (default; OpenAI native)
   *   - "chat_completions" — Chat Completions API (most third parties)
   *
   * When `openaiBaseUrl` is set and this is unset, defaults to
   * "chat_completions" automatically (broadest compatibility). Set
   * explicitly to "responses" only if your proxy supports it.
   */
  openaiApiMode: z.enum(["responses", "chat_completions"]).optional(),
  timezone: z.string().optional(),
  plugins: z.array(pluginEntrySchema).default([]),

  /**
   * Tool-surface trimming. Every registered MCP tool costs context
   * tokens in every session (name + description + schema), so
   * deployments that never use a tool group can reclaim that budget:
   *
   *   - `disabledToolTags` — hide whole groups by tag, e.g.
   *     ["stickers", "web", "triggers"]. See ToolTag in core/tools.
   *   - `disabledTools` — hide individual tools by name.
   *
   * `end_turn` can never be disabled: tool-only backends need it to
   * close every turn.
   */
  disabledTools: z.array(z.string()).optional(),
  disabledToolTags: z.array(z.string()).optional(),

  /**
   * Developer build flag. Gates dev-only affordances such as the
   * `/update` self-update command. Off by default so packaged /
   * end-user deployments never expose them.
   */
  devBuild: z.boolean().default(false),

  /**
   * Self-update settings for the `/update` command. Only takes effect
   * when `devBuild` is true AND the process runs from a git checkout.
   * Pulls `remote/branch` (fast-forward only), reinstalls deps, runs
   * any `setup` commands, then restarts.
   */
  update: z
    .object({
      remote: z.string().min(1).default("origin"),
      branch: z.string().min(1).default("main"),
      /** Extra shell commands run in the repo root after `npm install`. */
      setup: z.array(z.string()).optional(),
    })
    .optional(),

  // GitHub — GitHub API access via official MCP server
  github: z
    .object({
      enabled: z.boolean().default(false),
      /** GitHub personal access token (default: from `gh auth token`) */
      token: z.string().min(1).optional(),
    })
    .optional(),

  // Long-term memory — unified backend selection. Preferred over the
  // legacy top-level "mempalace"/"mem0" sections; when enabled it wins
  // over them (loadConfig mirrors it onto the section the loaders read).
  memory: z
    .object({
      enabled: z.boolean().default(false),
      backend: z.enum(["mempalace", "mem0"]).default("mempalace"),
      mempalace: mempalaceSettingsSchema.optional(),
      mem0: mem0SettingsSchema.optional(),
    })
    .optional(),

  // MemPalace — structured long-term memory with vector search
  // (legacy section; prefer "memory": { "backend": "mempalace", ... })
  mempalace: mempalaceSettingsSchema
    .extend({ enabled: z.boolean().default(false) })
    .optional(),

  // mem0 — long-term memory layer, hosted platform or self-hosted
  // (legacy-style section; prefer "memory": { "backend": "mem0", ... })
  mem0: mem0SettingsSchema
    .extend({ enabled: z.boolean().default(false) })
    .optional(),

  // Playwright — headless browser automation via MCP
  playwright: playwrightConfigSchema.optional(),

  // Soul — compiled, self-organizing identity kernel (experimental).
  // Off by default; when enabled, the projected identity surface is injected
  // into the system prompt and the organic pass runs on the dream cadence.
  soul: z
    .object({
      enabled: z.boolean().default(false),
      /** Kernel persistence path (default: ~/.talon/data/soul.json) */
      path: z.string().min(1).optional(),
    })
    .optional(),

  // Discord — discord.js v14-based frontend
  discord: discordConfigSchema.optional(),

  // Native — local bridge for the Electron companion app (apps/desktop)
  native: nativeConfigSchema.optional(),

  // Native tools — replace the SDK's built-in Read/Write/Edit/Bash/Glob/Grep
  // with Talon's own MCP equivalents (bash/read/write/edit/glob/search). The
  // native tools additionally route to the active `teleport` node, so file
  // and shell operations can transparently run on a companion device. When
  // true, the built-ins are dropped from the model's tool whitelist and the
  // native tools take their place. Off by default: enabling swaps the model's
  // own hands, so the cutover should be deliberate and observed (flip to true
  // and restart), with an instant rollback by flipping back to false.
  nativeTools: z.boolean().default(false),

  // Display name shown in terminal UI (defaults to "Talon")
  botDisplayName: z.string().default("Talon"),

  // Teams frontend (Power Automate webhooks)
  teamsWebhookUrl: z.string().url().optional(),
  teamsWebhookSecret: z.string().optional(),
  teamsWebhookPort: z.number().int().min(1024).max(65535).default(19878),
  teamsBotDisplayName: z.string().optional(),
  teamsTeamName: z.string().optional(),
  teamsChannelName: z.string().optional(),
  teamsChatTopic: z.string().optional(),
  teamsGraphPollMs: z.number().int().min(5000).default(10000),
});

// System-prompt assembly lives in core/prompt/ (section pipeline,
// templates, workspace listing). Re-exported here so existing
// consumers keep importing from util/config.
export {
  joinSystemPromptParts,
  type SystemPromptParts,
} from "../core/prompt/assemble.js";

export type TalonConfig = z.infer<typeof configSchema> & {
  systemPrompt: string;
  /**
   * Static/dynamic split of `systemPrompt`. Optional so hand-built test
   * configs stay valid; consumers fall back to treating `systemPrompt`
   * as all-static when absent. Always set by `loadConfig` and
   * `rebuildSystemPrompt`.
   */
  systemPromptParts?: SystemPromptParts;
  workspace: string;
};

/** Normalize frontend config to always be an array. */
export function getFrontends(config: TalonConfig): string[] {
  return Array.isArray(config.frontend) ? config.frontend : [config.frontend];
}

// ── Config file ─────────────────────────────────────────────────────────────

const CONFIG_FILE = pathFiles.config;

const DEFAULT_CONFIG = {
  botToken: "",
  model: "default",
  maxMessageLength: 4000,
  concurrency: 1,
  pulse: true,
  pulseIntervalMs: 300000,
};

function loadConfigFile(): Record<string, unknown> {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {
    /* corrupt — will be recreated */
  }
  return {};
}

function normalizeDeprecatedFrontendConfig(
  fileConfig: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...fileConfig };
  let usedAlias = false;

  const normalizeFrontendValue = (value: unknown): unknown => {
    if (value === "desktop") {
      usedAlias = true;
      return "native";
    }
    if (Array.isArray(value) && value.some((item) => item === "desktop")) {
      usedAlias = true;
      return value.map((item) => (item === "desktop" ? "native" : item));
    }
    return value;
  };

  if ("frontend" in normalized) {
    normalized.frontend = normalizeFrontendValue(normalized.frontend);
  }
  if ("desktop" in normalized) {
    usedAlias = true;
    if (!("native" in normalized)) {
      normalized.native = normalized.desktop;
    }
    delete normalized.desktop;
  }

  if (usedAlias) {
    console.warn(
      'Deprecated "desktop" frontend config detected; use "native" instead.',
    );
  }

  return normalized;
}

/**
 * First-run onboarding: creates workspace/talon.json with defaults.
 * Returns true if this is a fresh install.
 */
function ensureConfigFile(): boolean {
  if (!existsSync(dirs.root)) mkdirSync(dirs.root, { recursive: true });
  if (!existsSync(dirs.data)) mkdirSync(dirs.data, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    writeFileAtomic.sync(
      CONFIG_FILE,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
    );
    return true;
  }
  return false;
}

// ── System prompt assembly ──────────────────────────────────────────────────
// Delegated to core/prompt/assemble.ts — see that module for the
// section pipeline, file ownership rules, and the static/dynamic split.

// ── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(): TalonConfig {
  ensureConfigFile();
  const fileConfig = normalizeDeprecatedFrontendConfig(loadConfigFile());

  // Runtime frontend override (TALON_FRONTEND_OVERRIDE). Lets the native
  // companion app spawn a daemon on the `native` frontend without rewriting
  // the user's saved config (which may target Telegram/Discord). Validated
  // against the same enum, so a bogus value fails fast like any other.
  const frontendOverride = process.env.TALON_FRONTEND_OVERRIDE?.trim();
  if (frontendOverride) {
    fileConfig.frontend =
      frontendOverride === "desktop" ? "native" : frontendOverride;
    if (frontendOverride === "desktop") {
      console.warn(
        'Deprecated TALON_FRONTEND_OVERRIDE="desktop"; use "native" instead.',
      );
    }
  }

  const parsed = configSchema.parse(fileConfig);

  // Unified memory section: mirror the selected backend onto the per-plugin
  // section the loaders consume (builtins.ts reads config.mempalace /
  // config.mem0). The memory section wins over a legacy section when both
  // are present; the unselected backend is disabled so exactly one memory
  // plugin loads.
  if (parsed.memory?.enabled) {
    if (parsed.memory.backend === "mempalace") {
      parsed.mempalace = {
        ...parsed.mempalace,
        ...parsed.memory.mempalace,
        enabled: true,
      };
      if (parsed.mem0) parsed.mem0.enabled = false;
    } else {
      parsed.mem0 = { ...parsed.mem0, ...parsed.memory.mem0, enabled: true };
      if (parsed.mempalace) parsed.mempalace.enabled = false;
    }
  }

  // Apply timezone globally before building the system prompt
  setTimezone(parsed.timezone);

  // Validate per-frontend requirements
  const frontends = Array.isArray(parsed.frontend)
    ? parsed.frontend
    : [parsed.frontend];
  for (const fe of frontends) {
    if (fe === "telegram" && !parsed.botToken) {
      throw new Error(
        `Telegram frontend requires "botToken" in ${CONFIG_FILE}. Run "talon setup" to configure.`,
      );
    }
    if (fe === "teams" && !parsed.teamsWebhookUrl) {
      throw new Error(
        `Teams frontend requires "teamsWebhookUrl" in ${CONFIG_FILE}. Run "talon setup" to configure.`,
      );
    }
  }

  const activeFrontend = frontends[0];

  const promptParts = assembleSystemPrompt({ frontend: activeFrontend });
  return {
    ...parsed,
    workspace: dirs.workspace,
    systemPrompt: joinSystemPromptParts(promptParts),
    systemPromptParts: promptParts,
  };
}

/**
 * Rebuild the system prompt with plugin additions.
 * Called after plugins are loaded to inject their prompt contributions.
 */
export function rebuildSystemPrompt(
  config: TalonConfig,
  pluginAdditions: string[],
): void {
  const promptParts = buildSystemPromptPartsFor(
    config,
    pluginAdditions,
    primaryFrontend(config),
  );
  config.systemPromptParts = promptParts;
  config.systemPrompt = joinSystemPromptParts(promptParts);
}

/** The first configured frontend — the default prompt flavour. */
export function primaryFrontend(config: TalonConfig): string {
  const frontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return frontends[0];
}

/**
 * Build system-prompt parts for a specific frontend WITHOUT mutating
 * the config. Multi-frontend deployments need per-chat prompt
 * flavours (a native-app chat must get native.md guidance, not the
 * telegram.md that `frontends[0]` happens to be) — the per-session
 * snapshot layer (backend/shared/system-prompt.ts) calls this with the
 * chat's owning frontend and freezes the result per session.
 */
export function buildSystemPromptPartsFor(
  config: TalonConfig,
  pluginAdditions: string[],
  frontend: string,
): SystemPromptParts {
  return assembleSystemPrompt({
    frontend,
    pluginPromptAdditions:
      pluginAdditions.length > 0 ? pluginAdditions : undefined,
  });
}
