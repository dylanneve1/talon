import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// ── Config schema ───────────────────────────────────────────────────────────

const envSchema = z.object({
  botToken: z.string().min(1, "Missing bot token. Set TALON_BOT_TOKEN in .env or environment."),
  model: z.string().default("claude-sonnet-4-6"),
  workspace: z.string(),
  maxThinkingTokens: z.number().int().min(0).default(10000),
  maxMessageLength: z.number().int().min(100).default(4000),
  verbose: z.boolean().default(false),
  concurrency: z.number().int().min(1).max(20).default(3),
});

export type TalonConfig = z.infer<typeof envSchema> & {
  systemPrompt: string;
};

// ── .env file loading ───────────────────────────────────────────────────────

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
  loadEnvFile();

  const env = process.env;
  const parsed = envSchema.parse({
    botToken: env.TALON_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "",
    model: env.TALON_MODEL || undefined,
    workspace: resolve(env.TALON_WORKSPACE || process.cwd(), "workspace"),
    maxThinkingTokens: env.TALON_MAX_THINKING_TOKENS
      ? parseInt(env.TALON_MAX_THINKING_TOKENS, 10)
      : undefined,
    maxMessageLength: env.TALON_MAX_MESSAGE_LENGTH
      ? parseInt(env.TALON_MAX_MESSAGE_LENGTH, 10)
      : undefined,
    verbose: env.TALON_VERBOSE === "1" || env.TALON_VERBOSE === "true",
    concurrency: env.TALON_CONCURRENCY
      ? parseInt(env.TALON_CONCURRENCY, 10)
      : undefined,
  });

  return {
    ...parsed,
    systemPrompt: loadSystemPrompt(),
  };
}
