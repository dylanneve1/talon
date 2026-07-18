/**
 * CLI config model + load/save/format helpers, plus the banner.
 *
 * This is the on-disk `talon.json` shape as the CLI sees it; the runtime has
 * its own richer config type in util/config.ts.
 */

import pc from "picocolors";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { dirs } from "../util/paths.js";
import { CONFIG_FILE } from "./context.js";

export function printBanner(): void {
  console.log();
  console.log(`  ${pc.bold(pc.cyan("🦅 Talon"))}`);
  console.log(`  ${pc.dim("Agentic AI harness")}`);
  console.log();
}

export type Config = {
  frontend: string | string[];
  /** Active backend (`claude` / `kilo` / `opencode` / `codex` / `openai-agents`). */
  backend?: "claude" | "kilo" | "opencode" | "codex" | "openai-agents";
  botToken?: string;
  claudeBinary?: string;
  /** Codex-specific OpenAI API key. */
  codexApiKey?: string;
  /** OpenAI API key — used by OpenAI Agents and legacy Codex config. */
  openaiApiKey?: string;
  /** OpenAI-compatible base URL — OpenRouter, Azure, Ollama, LiteLLM, etc. */
  openaiBaseUrl?: string;
  /** OpenAI API surface — "responses" (default) or "chat_completions" (most third parties). */
  openaiApiMode?: "responses" | "chat_completions";
  model: string;
  concurrency: number;
  pulse: boolean;
  pulseIntervalMs: number;
  adminUserId?: number;
  apiId?: number;
  apiHash?: string;
  maxMessageLength: number;
  plugins?: unknown[];
  // Teams
  teamsWebhookUrl?: string;
  teamsWebhookSecret?: string;
  teamsWebhookPort?: number;
  teamsBotDisplayName?: string;
  // Discord
  discord?: {
    botToken: string;
    applicationId: string;
    allowedUsers?: string[];
    allowedGuilds?: string[];
    allowedChannels?: string[];
    adminUserIds?: string[];
    [key: string]: unknown;
  };
};

export const DEFAULTS: Config = {
  frontend: "telegram",
  model: "default",
  concurrency: 1,
  pulse: true,
  pulseIntervalMs: 300000,
  maxMessageLength: 4000,
};

export function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
    }
  } catch {
    /* corrupt */
  }
  return { ...DEFAULTS };
}

export function saveConfig(config: Config): void {
  if (!existsSync(dirs.root)) mkdirSync(dirs.root, { recursive: true });
  const clean = Object.fromEntries(
    Object.entries(config).filter(([, v]) => v !== undefined),
  );
  writeFileAtomic.sync(CONFIG_FILE, JSON.stringify(clean, null, 2) + "\n");
}

export function maskToken(token: string | undefined): string {
  if (!token || token.length < 10) return pc.red("not set");
  return pc.green(token.slice(0, 8) + "..." + token.slice(-4));
}

export function isConfigured(config: Config): boolean {
  const fes = Array.isArray(config.frontend)
    ? config.frontend
    : [config.frontend];
  return fes.every((fe) => {
    if (fe === "telegram") return !!config.botToken;
    if (fe === "teams") return !!config.teamsWebhookUrl;
    if (fe === "discord") return !!config.discord?.botToken;
    // terminal (stdio) and native (the client bridge) carry no
    // credentials; unknown names fail closed so a typo'd frontend sends
    // the user to setup instead of a daemon that can't start.
    return fe === "terminal" || fe === "native";
  });
}
