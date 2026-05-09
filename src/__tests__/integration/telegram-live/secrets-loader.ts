/**
 * Loader for live-tier Telegram test secrets.
 *
 * Looks in two places, in order:
 *   1. Environment variables (`TALON_TEST_BOT_TOKEN`, `TALON_TEST_CHAT_ID`).
 *      This is the path CI uses, with values pulled from GitHub repo secrets.
 *   2. `~/.config/talon-tests/secrets.env` — local dev convenience. The file
 *      should be plain `KEY=VALUE` lines with `0600` perms.
 *
 * The local file is NOT committed and lives outside any git tree. See
 * `memory/memory.md` ("Test bot token") for the canonical location and
 * the rule that the token never gets pasted anywhere committed or chat-logged.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface LiveTestSecrets {
  /** Telegram bot token (e.g. `123456:ABC-DEF...`). */
  botToken?: string;
  /** Chat ID the test bot can post into (numeric, may be negative for groups). */
  chatId?: number;
}

const SECRETS_PATH = resolve(
  homedir(),
  ".config",
  "talon-tests",
  "secrets.env",
);

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadLiveSecrets(): LiveTestSecrets {
  // Env wins over the dotenv file.
  let botToken = process.env.TALON_TEST_BOT_TOKEN;
  let chatIdRaw = process.env.TALON_TEST_CHAT_ID;

  if ((!botToken || !chatIdRaw) && existsSync(SECRETS_PATH)) {
    const file = parseDotenv(readFileSync(SECRETS_PATH, "utf8"));
    botToken ??= file.TALON_TEST_BOT_TOKEN;
    chatIdRaw ??= file.TALON_TEST_CHAT_ID;
  }

  const chatId = chatIdRaw ? Number(chatIdRaw) : undefined;
  return {
    botToken: botToken || undefined,
    chatId:
      chatId !== undefined && Number.isFinite(chatId) ? chatId : undefined,
  };
}

/**
 * Convenience: returns a string explaining what's missing, or null if both
 * secrets are present and valid. Use in test `describe.skipIf` rationale logs.
 */
export function describeMissingSecrets(): string | null {
  const s = loadLiveSecrets();
  const missing: string[] = [];
  if (!s.botToken) missing.push("TALON_TEST_BOT_TOKEN");
  if (!s.chatId) missing.push("TALON_TEST_CHAT_ID");
  if (missing.length === 0) return null;
  return (
    `Live-tier tests skipped — missing: ${missing.join(", ")}. ` +
    `Set them in env or in ~/.config/talon-tests/secrets.env.`
  );
}
