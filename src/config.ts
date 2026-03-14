import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TalonConfig = {
  botToken: string;
  model: string;
  systemPrompt: string;
  workspace: string;
  maxThinkingTokens: number;
  maxMessageLength: number;
  verbose: boolean;
};

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

function readOptionalFile(path: string): string {
  try {
    if (existsSync(path)) return readFileSync(path, "utf-8").trim();
  } catch { /* ignore */ }
  return "";
}

function loadSystemPrompt(): string {
  if (process.env.TALON_SYSTEM_PROMPT) {
    return process.env.TALON_SYSTEM_PROMPT;
  }

  const base = process.cwd();
  const parts: string[] = [];

  // Soul — personality and identity
  const soul = readOptionalFile(resolve(base, "prompts", "soul.md"));
  if (soul) parts.push(soul);

  // Custom prompt overrides default
  const custom = readOptionalFile(resolve(base, "prompts", "custom.md"));
  const defaultPrompt = readOptionalFile(resolve(base, "prompts", "default.md"));
  parts.push(custom || defaultPrompt || "You are a helpful AI assistant.");

  // Memory — persistent facts and context
  const memory = readOptionalFile(resolve(base, "workspace", "memory", "memory.md"));
  if (memory) parts.push(`## Persistent Memory\n\nThe following is your memory file. Reference it naturally. Update it via the Write tool when you learn important new information.\nFile: workspace/memory/memory.md\n\n${memory}`);

  // Daily logs for continuity
  parts.push(`## Daily Logs\n\nBrief interaction summaries are saved at workspace/logs/YYYY-MM-DD.md. You can read these files to review past activity and maintain continuity across sessions.`);

  // Today's date for temporal awareness
  parts.push(`\n## Current Date\n${new Date().toISOString().slice(0, 10)}`);

  return parts.join("\n\n---\n\n");
}

export function loadConfig(): TalonConfig {
  loadEnvFile();

  const botToken = process.env.TALON_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  if (!botToken) {
    throw new Error("Missing bot token. Set TALON_BOT_TOKEN in .env or environment.");
  }

  return {
    botToken,
    model: process.env.TALON_MODEL || "claude-sonnet-4-6",
    systemPrompt: loadSystemPrompt(),
    workspace: resolve(process.env.TALON_WORKSPACE || process.cwd(), "workspace"),
    maxThinkingTokens: parseInt(process.env.TALON_MAX_THINKING_TOKENS || "10000", 10),
    maxMessageLength: parseInt(process.env.TALON_MAX_MESSAGE_LENGTH || "4000", 10),
    verbose: process.env.TALON_VERBOSE === "1" || process.env.TALON_VERBOSE === "true",
  };
}
