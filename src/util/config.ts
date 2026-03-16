import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

// ── Config schema ───────────────────────────────────────────────────────────

const configSchema = z.object({
  botToken: z.string().min(1, "Missing bot token"),
  model: z.string().default("claude-sonnet-4-6"),
  maxMessageLength: z.number().int().min(100).default(4000),
  // Default 1: bridge context is global, concurrent queries to different
  // chats would route tools to the wrong chat.
  concurrency: z.number().int().min(1).max(20).default(1),
  // Telegram user API for full history access (optional)
  apiId: z.number().int().optional(),
  apiHash: z.string().optional(),
  // Admin user ID — enables /admin commands
  adminUserId: z.number().int().optional(),
  // Pulse settings
  pulse: z.boolean().default(true),
  pulseIntervalMs: z.number().int().min(60000).default(300000),
});

export type TalonConfig = z.infer<typeof configSchema> & {
  systemPrompt: string;
  workspace: string;
};

// ── Config file loading ─────────────────────────────────────────────────────

const CONFIG_FILE = resolve(process.cwd(), "workspace", "talon.json");

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
  } catch {
    // Corrupt file — recreate
  }
  return {};
}

/**
 * First-run onboarding: creates workspace/talon.json with defaults.
 * Returns true if this is a fresh install (no config existed).
 */
function ensureConfigFile(): boolean {
  const workspace = resolve(process.cwd(), "workspace");
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    writeFileAtomic.sync(
      CONFIG_FILE,
      JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
    );
    return true;
  }
  return false;
}

// ── Legacy .env loading (fallback) ──────────────────────────────────────────

function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
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

function loadSystemPrompt(): string {
  if (process.env.TALON_SYSTEM_PROMPT) {
    return process.env.TALON_SYSTEM_PROMPT;
  }

  const base = process.cwd();
  const parts: string[] = [];

  const soul = readOptionalFile(resolve(base, "prompts", "soul.md"));
  if (soul) parts.push(soul);

  const custom = readOptionalFile(resolve(base, "prompts", "custom.md"));
  const defaultPrompt = readOptionalFile(resolve(base, "prompts", "default.md"));
  parts.push(custom || defaultPrompt || "You are a helpful AI assistant.");

  const memory = readOptionalFile(resolve(base, "workspace", "memory", "memory.md"));
  if (memory)
    parts.push(
      `## Persistent Memory\n\nThe following is your memory file. Reference it naturally. Update it via the Write tool when you learn important new information.\nFile: workspace/memory/memory.md\n\n${memory}`,
    );

  parts.push(`## Workspace

You have a workspace directory at \`workspace/\`. This is your home — organize it however you want.
- \`workspace/memory/memory.md\` is your persistent memory file. Update it when you learn important things.
- Daily interaction logs are saved to \`workspace/logs/\` automatically.
- Files users send you (photos, docs, voice) are saved to \`workspace/uploads/\`.
- \`workspace/cron.json\` stores your persistent cron jobs. Use the cron tools to create recurring tasks.
- Everything else is yours to create and organize as you see fit.

## Cron Jobs

You can create persistent recurring scheduled tasks using cron tools. Jobs survive restarts.
- \`create_cron_job\` — create a new recurring job with a cron schedule
- \`list_cron_jobs\` — list all jobs in the current chat
- \`edit_cron_job\` — modify an existing job (schedule, content, enable/disable)
- \`delete_cron_job\` — remove a job permanently
Two job types: "message" sends text directly, "query" runs a Claude prompt with full tool access.`);

  parts.push(`## Current Date\n${new Date().toISOString().slice(0, 10)}`);

  return parts.join("\n\n---\n\n");
}

// ── Main loader ─────────────────────────────────────────────────────────────

export function loadConfig(): TalonConfig {
  // Load .env for backward compatibility
  loadEnvFile();

  // First-run onboarding: create config file with defaults
  const isFirstRun = ensureConfigFile();

  // Load from talon.json, then fall back to env vars
  const fileConfig = loadConfigFile();
  const env = process.env;

  const raw = {
    botToken:
      (fileConfig.botToken as string) ||
      env.TALON_BOT_TOKEN ||
      env.TELEGRAM_BOT_TOKEN ||
      "",
    model: (fileConfig.model as string) || env.TALON_MODEL || undefined,
    maxMessageLength: (fileConfig.maxMessageLength as number) ??
      (env.TALON_MAX_MESSAGE_LENGTH ? parseInt(env.TALON_MAX_MESSAGE_LENGTH, 10) : undefined),
    concurrency: (fileConfig.concurrency as number) ??
      (env.TALON_CONCURRENCY ? parseInt(env.TALON_CONCURRENCY, 10) : undefined),
    apiId: (fileConfig.apiId as number) ??
      (env.TALON_API_ID ? parseInt(env.TALON_API_ID, 10) : undefined),
    apiHash: (fileConfig.apiHash as string) || env.TALON_API_HASH || undefined,
    adminUserId: (fileConfig.adminUserId as number) ??
      (env.TALON_ADMIN_USER_ID ? parseInt(env.TALON_ADMIN_USER_ID, 10) : undefined),
    pulse: (fileConfig.pulse as boolean) ?? env.TALON_PULSE !== "0",
    pulseIntervalMs: (fileConfig.pulseIntervalMs as number) ??
      (env.TALON_PULSE_INTERVAL_MS ? parseInt(env.TALON_PULSE_INTERVAL_MS, 10) : undefined),
  };

  // Helpful error on first run
  if (!raw.botToken) {
    if (isFirstRun) {
      console.log("\n  Welcome to Talon! 🦅\n");
      console.log(`  Config created at: ${CONFIG_FILE}`);
      console.log("  Edit it to add your bot token from @BotFather, then restart.\n");
      process.exit(0);
    }
    throw new Error(
      `Missing bot token. Add "botToken" to ${CONFIG_FILE} or set TALON_BOT_TOKEN.`,
    );
  }

  const parsed = configSchema.parse(raw);
  const workspace = resolve(process.cwd(), "workspace");

  return {
    ...parsed,
    workspace,
    systemPrompt: loadSystemPrompt(),
  };
}
