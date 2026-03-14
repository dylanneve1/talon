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

function loadSystemPrompt(): string {
  // Priority: env var > custom file > default prompt file
  if (process.env.TALON_SYSTEM_PROMPT) {
    return process.env.TALON_SYSTEM_PROMPT;
  }

  const customPath = resolve(process.cwd(), "prompts", "custom.md");
  if (existsSync(customPath)) {
    return readFileSync(customPath, "utf-8").trim();
  }

  const defaultPath = resolve(process.cwd(), "prompts", "default.md");
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, "utf-8").trim();
  }

  return "You are a helpful AI assistant.";
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
