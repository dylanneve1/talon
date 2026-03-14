import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type TalonConfig = {
  /** Telegram bot token. */
  botToken: string;
  /** Claude model ID. */
  model: string;
  /** System prompt for the agent. */
  systemPrompt: string;
  /** Working directory for the agent SDK subprocess. */
  workspace: string;
  /** Max thinking tokens per turn. */
  maxThinkingTokens: number;
  /** Max message length before splitting (Telegram limit is 4096). */
  maxMessageLength: number;
  /** Whether to log detailed usage metrics. */
  verbose: boolean;
};

const DEFAULT_SYSTEM_PROMPT = `You are Talon, a sharp and helpful AI assistant on Telegram.
Be concise and conversational. No filler. Answer directly.
In groups, you'll see messages prefixed with [Name]: — use their name naturally.
You have access to tools. Use them when helpful, don't ask for permission.
Keep responses short unless asked for detail. Use markdown sparingly.`;

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
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(): TalonConfig {
  loadEnvFile();

  const botToken = process.env.TALON_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
  if (!botToken) {
    throw new Error(
      "Missing bot token. Set TALON_BOT_TOKEN in .env or environment.",
    );
  }

  const workspace = resolve(
    process.env.TALON_WORKSPACE || process.cwd(),
    "workspace",
  );

  return {
    botToken,
    model: process.env.TALON_MODEL || "claude-sonnet-4-6",
    systemPrompt: process.env.TALON_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    workspace,
    maxThinkingTokens: parseInt(process.env.TALON_MAX_THINKING_TOKENS || "10000", 10),
    maxMessageLength: parseInt(process.env.TALON_MAX_MESSAGE_LENGTH || "4000", 10),
    verbose: process.env.TALON_VERBOSE === "1" || process.env.TALON_VERBOSE === "true",
  };
}
