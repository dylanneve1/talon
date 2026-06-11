import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { dirs, files as pathFiles } from "./paths.js";
import { setTimezone, todayAndYesterday } from "./time.js";
import { log } from "./log.js";
import { BACKEND_IDS } from "../core/agent-runtime/model-ref.js";

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

const frontendEnum = z.enum(["telegram", "terminal", "teams", "discord"]);

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
  heartbeat: z.boolean().default(false),
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

  // GitHub — GitHub API access via official MCP server
  github: z
    .object({
      enabled: z.boolean().default(false),
      /** GitHub personal access token (default: from `gh auth token`) */
      token: z.string().min(1).optional(),
    })
    .optional(),

  // MemPalace — structured long-term memory with vector search
  mempalace: z
    .object({
      enabled: z.boolean().default(false),
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
    })
    .optional(),

  // Playwright — headless browser automation via MCP
  playwright: playwrightConfigSchema.optional(),

  // Discord — discord.js v14-based frontend
  discord: discordConfigSchema.optional(),

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

/**
 * System prompt split for prompt-cache friendliness.
 *
 * `staticText` holds everything that is stable for the lifetime of a
 * session (identity, base/frontend prompts, memory file, tool docs,
 * plugin additions). `dynamicText` holds volatile context (workspace
 * file listing, daily-memory pointer) that changes between rebuilds.
 *
 * The Claude SDK backend sends these as separate blocks divided by
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, so the static prefix is eligible
 * for cross-session prompt caching while volatile content lives after
 * the cache boundary. Other backends join them into a single string —
 * keeping volatile content last still maximises their providers'
 * automatic prefix caching.
 */
export type SystemPromptParts = {
  staticText: string;
  dynamicText: string;
};

/** Join the two prompt parts into the single-string form. */
export function joinSystemPromptParts(parts: SystemPromptParts): string {
  if (!parts.dynamicText) return parts.staticText;
  if (!parts.staticText) return parts.dynamicText;
  return `${parts.staticText}\n\n---\n\n${parts.dynamicText}`;
}

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

function readOptionalFile(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch {
    /* ignore */
  }
  return "";
}

let lastLoggedPromptKey = "";

/**
 * Assemble the system prompt from prompt files, memory, and plugin
 * additions.
 *
 * Returns a static/dynamic split (see `SystemPromptParts`). Everything
 * volatile — the workspace file listing (file sizes change as logs
 * grow) and the daily-memory pointer (contains today's date) — goes in
 * `dynamicText` so the static prefix stays byte-identical between
 * rebuilds as long as the prompt files, memory, and plugins are
 * unchanged. A byte-identical static prefix is what makes provider
 * prompt caching hit across sessions.
 *
 * Deliberately omitted: a "Current Date & Time" section. Every user
 * message already carries a `[YYYY-MM-DD HH:MM:SS]` tag (see
 * `formatUserPrompt`), the daily-memory pointer names today's file,
 * and the `check_time` tool covers timezone queries. A minute-precision
 * timestamp in the system prompt was the single biggest cache-buster:
 * it guaranteed every rebuild produced a unique prompt.
 */
function loadSystemPrompt(
  frontend?: string,
  pluginPromptAdditions?: string[],
): SystemPromptParts {
  const promptDir = dirs.prompts;
  const parts: string[] = [];
  const dynamicParts: string[] = [];

  const loaded: string[] = [];

  // Identity — static personality from prompts/identity.md + dynamic config from ~/.talon/workspace/identity.md
  const identityPrompt = readOptionalFile(resolve(promptDir, "identity.md"));
  const identityUser = readOptionalFile(pathFiles.identity);
  if (identityPrompt || identityUser) {
    const identityParts = [identityPrompt, identityUser].filter(Boolean);
    parts.push(`## Identity\n\n${identityParts.join("\n\n")}`);
    loaded.push("identity");
  }

  // Load base prompt (shared across all frontends)
  const custom = readOptionalFile(resolve(promptDir, "custom.md"));
  const basePrompt = readOptionalFile(resolve(promptDir, "base.md"));
  if (custom) {
    parts.push(custom);
    loaded.push("custom");
  } else if (basePrompt) {
    parts.push(basePrompt);
    loaded.push("base");
  } else parts.push("You are a sharp and helpful AI assistant.");

  // Load frontend-specific prompt
  const frontendFile = `${frontend ?? "telegram"}.md`;
  const frontendPrompt = readOptionalFile(resolve(promptDir, frontendFile));
  if (frontendPrompt) {
    parts.push(frontendPrompt);
    loaded.push(frontendFile.replace(".md", ""));
  }

  const memory = readOptionalFile(pathFiles.memory);
  if (memory) {
    parts.push(
      `## Persistent Memory\n\nThe following is your memory file. Reference it naturally. Update it via the Write tool when you learn important new information.\nFile: ~/.talon/workspace/memory/memory.md\n\n${memory}`,
    );
    loaded.push("memory");
  }

  // Point the bot at daily memory files (read on demand, not injected).
  // Dynamic: names today's file, so it changes at midnight.
  const { today } = todayAndYesterday();
  dynamicParts.push(
    `## Daily Memory\n\nYour daily notes are stored in \`${dirs.dailyMemory}/\`. Today's file is \`${today}.md\`. Use the Read tool to check recent daily notes when you need context from previous days.`,
  );

  const loadedKey = loaded.join(" + ");
  if (loadedKey && loadedKey !== lastLoggedPromptKey) {
    log("config", `System prompt: ${loadedKey}`);
    lastLoggedPromptKey = loadedKey;
  }

  // Workspace file listing for context. Dynamic: file sizes change as
  // logs grow, so even back-to-back rebuilds differ.
  //
  // Any directory with more than 8 rendered entries collapses to a single
  // `name/ (N files)` summary line, so the per-file sizes inside such a
  // directory are computed and then thrown away. The tree is therefore built
  // lazily: `statSync` is deferred to render time and is only ever called for
  // files that actually appear in the output. The earlier implementation
  // stat'd every file eagerly during the walk — on a workspace with tens of
  // thousands of files (logs, build artifacts, media) that meant one blocking
  // `statSync` syscall per file on every session start, walking the whole
  // tree just to print a handful of summary lines.
  const workspaceDir = dirs.workspace;
  let workspaceFiles = "";
  try {
    // A node contributes `count` rendered lines to its parent (used to decide
    // the >8 collapse) and renders those lines lazily via `render()`.
    type Node = { count: number; render: () => string[] };

    const buildNode = (dir: string, prefix: string): Node => {
      const children: Node[] = [];
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (
            e.name.startsWith(".") ||
            e.name === "node_modules" ||
            e.name === "talon.log"
          )
            continue;
          const full = resolve(dir, e.name);
          if (e.isDirectory()) {
            const sub = buildNode(full, `${prefix}${e.name}/`);
            if (sub.count === 0) continue; // empty dir → omitted
            if (sub.count <= 8) {
              children.push(sub); // expand inline
            } else {
              // Collapse to one summary line — never render (or stat) the
              // files inside.
              const line = `${prefix}${e.name}/ (${sub.count} files)`;
              children.push({ count: 1, render: () => [line] });
            }
          } else {
            children.push({
              count: 1,
              render: () => {
                let sz = 0;
                try {
                  sz = statSync(full).size;
                } catch {
                  /* file vanished between readdir and stat — show 0B */
                }
                return [
                  `${prefix}${e.name} (${sz < 1024 ? sz + "B" : (sz / 1024).toFixed(0) + "KB"})`,
                ];
              },
            });
          }
        }
      } catch {
        /* unreadable dir → treat as empty */
      }
      const count = children.reduce((n, c) => n + c.count, 0);
      return { count, render: () => children.flatMap((c) => c.render()) };
    };

    const files = buildNode(workspaceDir, "").render();
    if (files.length > 0)
      workspaceFiles =
        "## Current Workspace Contents\n\n" +
        files.map((f) => `  ${f}`).join("\n");
  } catch {
    /* no workspace yet */
  }
  if (workspaceFiles) dynamicParts.push(workspaceFiles);

  parts.push(`## Workspace

You have a workspace directory at \`~/.talon/workspace/\`. This is your home — organize it however you want.
- \`~/.talon/workspace/memory/memory.md\` is your persistent memory file. Update it when you learn important things.
- \`~/.talon/workspace/memory/daily/YYYY-MM-DD.md\` is your daily notes file. Write observations, learnings, corrections, and follow-ups here throughout the day. Keep entries concise.
- Daily interaction logs are saved to \`~/.talon/workspace/logs/\` automatically.
- Files users send you (photos, docs, voice) are saved to \`~/.talon/workspace/uploads/\`.
- Persistent cron jobs are managed via the cron tools.
- Everything else is yours to create and organize as you see fit.

## Cron Jobs

You can create persistent recurring scheduled tasks using cron tools. Jobs survive restarts.
- \`create_cron_job\` — create a new recurring job with a cron schedule
- \`list_cron_jobs\` — list all jobs in the current chat
- \`edit_cron_job\` — modify an existing job (schedule, content, enable/disable)
- \`delete_cron_job\` — remove a job permanently
Two job types: "message" sends text directly, "query" runs a Claude prompt with full tool access.

---

## Triggers (long-running watcher scripts)

You can author **arbitrary scripts** that run as supervised subprocesses and signal back to wake you up — for polling, watching, or waiting on conditions where a fixed cron schedule doesn't fit. Use these when "check periodically until X" or "fire when Y changes" is a better fit than a calendar.

Tools:
- \`trigger_create(name, language, script, timeout_seconds?, description?)\` — write and spawn the script
- \`trigger_list\` — list all triggers in this chat with status, fire count, last error
- \`trigger_cancel(trigger_id)\` — SIGTERM (then SIGKILL after 5s)
- \`trigger_logs(trigger_id, lines?)\` — tail of stdout + stderr from the run
- \`trigger_delete(trigger_id)\` — remove from disk (cancels first if alive)

Languages: \`bash\`, \`python\`, \`node\`.

**Stdout protocol:**
- A line starting with \`TALON_FIRE: <text>\` fires a wake-up immediately and the script keeps running. Use this for watchers that emit multiple events.
- Exit 0 → final wake-up with the tail of the log as payload.
- Exit non-zero → error wake-up with the exit code and log tail.
- Hard timeout (default 24h, max 7d) → "timed_out" wake-up.

When a trigger fires, you receive a system-prefixed wake-up message containing the trigger name, status, and payload. You decide whether to message the user, take an action, or do nothing.

**Limits:** 5 active triggers per chat. Triggers are killed on Talon shutdown — they do **not** survive a restart. If you need persistence across restarts, recreate them when you see status "terminated" in \`trigger_list\`.

**When to use cron vs triggers:**
- "Every Monday at 9 AM" → cron (calendar-driven, recurring)
- "Wake me when this PR merges" → trigger (one-shot, condition-driven)
- "Tell me if BTC moves >5%" → trigger with mid-run \`TALON_FIRE:\` (long-running, multi-event)`);

  // Plugin system prompt contributions (injected by caller). Static:
  // they only change on plugin reload, which triggers a full rebuild.
  if (pluginPromptAdditions) {
    for (const addition of pluginPromptAdditions) {
      parts.push(addition);
    }
  }

  return {
    staticText: parts.join("\n\n---\n\n"),
    dynamicText: dynamicParts.join("\n\n---\n\n"),
  };
}

// ── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(): TalonConfig {
  ensureConfigFile();
  const fileConfig = loadConfigFile();

  const parsed = configSchema.parse(fileConfig);

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

  const promptParts = loadSystemPrompt(activeFrontend);
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
  const frontends = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  const promptParts = loadSystemPrompt(
    frontends[0],
    pluginAdditions.length > 0 ? pluginAdditions : undefined,
  );
  config.systemPromptParts = promptParts;
  config.systemPrompt = joinSystemPromptParts(promptParts);
}
