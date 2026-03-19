import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

// ── Config schema ───────────────────────────────────────────────────────────

const pluginEntrySchema = z.object({
  path: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});

const frontendEnum = z.enum(["telegram", "terminal"]);

const configSchema = z.object({
  frontend: z.union([frontendEnum, z.array(frontendEnum)]).default("telegram"),
  botToken: z.string().optional(),
  backend: z.enum(["claude", "opencode"]).default("claude"),
  model: z.string().default("claude-sonnet-4-6"),
  maxMessageLength: z.number().int().min(100).default(4000),
  concurrency: z.number().int().min(1).max(20).default(1),
  apiId: z.number().int().optional(),
  apiHash: z.string().optional(),
  adminUserId: z.number().int().optional(),
  pulse: z.boolean().default(true),
  pulseIntervalMs: z.number().int().min(60000).default(300000),
  braveApiKey: z.string().optional(),
  searxngUrl: z.string().default("http://localhost:8080"),
  plugins: z.array(pluginEntrySchema).default([]),
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

  // Workspace file listing for context
  const workspaceDir = resolve(base, "workspace");
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

You have a workspace directory at \`workspace/\`. This is your home — organize it however you want.
- \`workspace/memory/memory.md\` is your persistent memory file. Update it when you learn important things.
- Daily interaction logs are saved to \`workspace/logs/\` automatically.
- Files users send you (photos, docs, voice) are saved to \`workspace/uploads/\`.
- \`workspace/cron.json\` stores your persistent cron jobs. Use the cron tools to create recurring tasks.
- Everything else is yours to create and organize as you see fit.${workspaceFiles}

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

  const parsed = configSchema.parse(fileConfig);

  // Validate per-frontend requirements
  const frontends = Array.isArray(parsed.frontend) ? parsed.frontend : [parsed.frontend];
  for (const fe of frontends) {
    if (fe === "telegram" && !parsed.botToken) {
      throw new Error(`Telegram frontend requires "botToken" in ${CONFIG_FILE}. Run "talon setup" to configure.`);
    }
  }

  const workspace = resolve(process.cwd(), "workspace");

  return {
    ...parsed,
    workspace,
    systemPrompt: loadSystemPrompt(),
  };
}
