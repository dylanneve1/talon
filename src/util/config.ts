import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { dirs, files as pathFiles } from "./paths.js";
import { setTimezone, formatFullDatetime } from "./time.js";
import { log } from "./log.js";


// ── Config schema ───────────────────────────────────────────────────────────

const pluginEntrySchema = z.object({
  path: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const frontendEnum = z.enum(["telegram", "terminal", "teams"]);

const configSchema = z.object({
  frontend: z.union([frontendEnum, z.array(frontendEnum)]).default("telegram"),
  botToken: z.string().optional(),
  backend: z.enum(["claude", "opencode"]).default("claude"),
  claudeBinary: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  dreamModel: z.string().optional(), // Model used for background memory consolidation (defaults to main model)
  maxMessageLength: z.number().int().min(100).default(4000),
  concurrency: z.number().int().min(1).max(20).default(1),
  apiId: z.number().int().optional(),
  apiHash: z.string().optional(),
  adminUserId: z.number().int().optional(),
  pulse: z.boolean().default(true),
  pulseIntervalMs: z.number().int().min(60000).default(300000),
  braveApiKey: z.string().optional(),
  searxngUrl: z.string().default("http://localhost:8080"),
  timezone: z.string().optional(),
  plugins: z.array(pluginEntrySchema).default([]),

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

export type TalonConfig = z.infer<typeof configSchema> & {
  systemPrompt: string;
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
  model: "claude-sonnet-4-6",
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
  } catch { /* corrupt — will be recreated */ }
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
    writeFileAtomic.sync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return true;
  }
  return false;
}

// ── System prompt assembly ──────────────────────────────────────────────────

function readOptionalFile(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch { /* ignore */ }
  return "";
}

let lastLoggedPromptKey = "";

function loadSystemPrompt(frontend?: string, pluginPromptAdditions?: string[]): string {
  const promptDir = dirs.prompts;
  const parts: string[] = [];

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
  if (custom) { parts.push(custom); loaded.push("custom"); }
  else if (basePrompt) { parts.push(basePrompt); loaded.push("base"); }
  else parts.push("You are a sharp and helpful AI assistant.");

  // Load frontend-specific prompt
  const frontendFile = `${frontend ?? "telegram"}.md`;
  const frontendPrompt = readOptionalFile(resolve(promptDir, frontendFile));
  if (frontendPrompt) { parts.push(frontendPrompt); loaded.push(frontendFile.replace(".md", "")); }

  const memory = readOptionalFile(pathFiles.memory);
  if (memory) {
    parts.push(
      `## Persistent Memory\n\nThe following is your memory file. Reference it naturally. Update it via the Write tool when you learn important new information.\nFile: ~/.talon/workspace/memory/memory.md\n\n${memory}`,
    );
    loaded.push("memory");
  }

  const loadedKey = loaded.join(" + ");
  if (loadedKey && loadedKey !== lastLoggedPromptKey) {
    log("config", `System prompt: ${loadedKey}`);
    lastLoggedPromptKey = loadedKey;
  }

  // Workspace file listing for context
  const workspaceDir = dirs.workspace;
  let workspaceFiles = "";
  try {
    const listDir = (dir: string, prefix = ""): string[] => {
      const entries: string[] = [];
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "talon.log") continue;
          const full = resolve(dir, e.name);
          if (e.isDirectory()) {
            const sub = listDir(full, `${prefix}${e.name}/`);
            if (sub.length > 0 && sub.length <= 8) entries.push(...sub);
            else if (sub.length > 8) entries.push(`${prefix}${e.name}/ (${sub.length} files)`);
          } else {
            const sz = statSync(full).size;
            entries.push(`${prefix}${e.name} (${sz < 1024 ? sz + "B" : (sz / 1024).toFixed(0) + "KB"})`);
          }
        }
      } catch { /* skip */ }
      return entries;
    };
    const files = listDir(workspaceDir);
    if (files.length > 0) workspaceFiles = "\n\nCurrent workspace contents:\n" + files.map((f) => `  ${f}`).join("\n");
  } catch { /* no workspace yet */ }

  parts.push(`## Workspace

You have a workspace directory at \`~/.talon/workspace/\`. This is your home — organize it however you want.
- \`~/.talon/workspace/memory/memory.md\` is your persistent memory file. Update it when you learn important things.
- Daily interaction logs are saved to \`~/.talon/workspace/logs/\` automatically.
- Files users send you (photos, docs, voice) are saved to \`~/.talon/workspace/uploads/\`.
- Persistent cron jobs are managed via the cron tools.
- Everything else is yours to create and organize as you see fit.${workspaceFiles}

## Cron Jobs

You can create persistent recurring scheduled tasks using cron tools. Jobs survive restarts.
- \`create_cron_job\` — create a new recurring job with a cron schedule
- \`list_cron_jobs\` — list all jobs in the current chat
- \`edit_cron_job\` — modify an existing job (schedule, content, enable/disable)
- \`delete_cron_job\` — remove a job permanently
Two job types: "message" sends text directly, "query" runs a Claude prompt with full tool access.`);

  parts.push(`## Current Date & Time\n${formatFullDatetime()}`);

  // Plugin system prompt contributions (injected by caller)
  if (pluginPromptAdditions) {
    for (const addition of pluginPromptAdditions) {
      parts.push(addition);
    }
  }

  return parts.join("\n\n---\n\n");
}

// ── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(): TalonConfig {
  ensureConfigFile();
  const fileConfig = loadConfigFile();

  const parsed = configSchema.parse(fileConfig);

  // Apply timezone globally before building the system prompt
  setTimezone(parsed.timezone);

  // Validate per-frontend requirements
  const frontends = Array.isArray(parsed.frontend) ? parsed.frontend : [parsed.frontend];
  for (const fe of frontends) {
    if (fe === "telegram" && !parsed.botToken && !(parsed.apiId && parsed.apiHash)) {
      throw new Error(
        `Telegram frontend requires either "botToken" (bot mode) or "apiId" + "apiHash" (userbot mode) in ${CONFIG_FILE}. Run "talon setup" to configure.`,
      );
    }
    if (fe === "teams" && !parsed.teamsWebhookUrl) {
      throw new Error(`Teams frontend requires "teamsWebhookUrl" in ${CONFIG_FILE}. Run "talon setup" to configure.`);
    }
  }

  const activeFrontend = frontends[0];

  return {
    ...parsed,
    workspace: dirs.workspace,
    systemPrompt: loadSystemPrompt(activeFrontend),
  };
}

/**
 * Rebuild the system prompt with plugin additions.
 * Called after plugins are loaded to inject their prompt contributions.
 */
export function rebuildSystemPrompt(config: TalonConfig, pluginAdditions: string[]): void {
  const frontends = Array.isArray(config.frontend) ? config.frontend : [config.frontend];
  config.systemPrompt = loadSystemPrompt(frontends[0], pluginAdditions.length > 0 ? pluginAdditions : undefined);
}
