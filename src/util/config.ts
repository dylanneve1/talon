import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

// ── Config schema ───────────────────────────────────────────────────────────

const configSchema = z.object({
  botToken: z.string().min(1, "Missing bot token"),
  backend: z.enum(["claude", "opencode"]).default("claude"),
  model: z.string().default("claude-sonnet-4-6"),
  maxMessageLength: z.number().int().min(100).default(4000),
  concurrency: z.number().int().min(1).max(20).default(1),
  apiId: z.number().int().optional(),
  apiHash: z.string().optional(),
  adminUserId: z.number().int().optional(),
  pulse: z.boolean().default(true),
  pulseIntervalMs: z.number().int().min(60000).default(300000),
});

export type TalonConfig = z.infer<typeof configSchema> & {
  systemPrompt: string;
  workspace: string;
};

// ── Config file ─────────────────────────────────────────────────────────────

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
  } catch { /* corrupt — will be recreated */ }
  return {};
}

/**
 * First-run onboarding: creates workspace/talon.json with defaults.
 * Returns true if this is a fresh install.
 */
function ensureConfigFile(): boolean {
  const workspace = resolve(process.cwd(), "workspace");
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
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

function loadSystemPrompt(): string {
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
  const isFirstRun = ensureConfigFile();
  const fileConfig = loadConfigFile();

  if (!fileConfig.botToken) {
    if (isFirstRun) {
      console.log("\n  🦅 Welcome to Talon!\n");
      console.log(`  Run ${"\x1b[36m"}talon setup${"\x1b[0m"} for guided setup.`);
      console.log(`  Or edit ${CONFIG_FILE} manually.\n`);
      process.exit(0);
    }
    throw new Error(`Missing bot token. Run "talon setup" or add "botToken" to ${CONFIG_FILE}.`);
  }

  const parsed = configSchema.parse(fileConfig);
  const workspace = resolve(process.cwd(), "workspace");

  return {
    ...parsed,
    workspace,
    systemPrompt: loadSystemPrompt(),
  };
}
