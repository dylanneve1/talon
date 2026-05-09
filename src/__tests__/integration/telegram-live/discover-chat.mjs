#!/usr/bin/env node
/**
 * One-shot helper for first-time setup of live-tier tests:
 *
 *   1. Source `~/.config/talon-tests/secrets.env` (or pass `TALON_TEST_BOT_TOKEN`
 *      via env).
 *   2. Have a human send the bot a message (DM, group join, anything).
 *   3. Run `node discover-chat.mjs` — it polls `getUpdates`, picks the most
 *      recent chat, and prints what to set as `TALON_TEST_CHAT_ID`.
 *
 * Doesn't write to the secrets file automatically — keeps the human in the
 * loop on what gets persisted.
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SECRETS = resolve(homedir(), ".config", "talon-tests", "secrets.env");

let token = process.env.TALON_TEST_BOT_TOKEN;
if (!token && existsSync(SECRETS)) {
  for (const line of readFileSync(SECRETS, "utf8").split(/\r?\n/)) {
    const m = line.match(/^TALON_TEST_BOT_TOKEN\s*=\s*(.+)$/);
    if (m) {
      token = m[1].trim().replace(/^['"]|['"]$/g, "");
      break;
    }
  }
}

if (!token) {
  console.error(
    "discover-chat: TALON_TEST_BOT_TOKEN not set in env or " + SECRETS,
  );
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/getUpdates`;
const resp = await fetch(url);
const data = await resp.json();

if (!data.ok) {
  console.error("discover-chat: API error:", data);
  process.exit(2);
}

const chats = new Map();
for (const update of data.result) {
  const msg = update.message ?? update.edited_message ?? null;
  if (!msg?.chat) continue;
  chats.set(msg.chat.id, msg.chat);
}

if (chats.size === 0) {
  console.log(
    "discover-chat: 0 updates. Have a human send the bot any message " +
      "(DM, group join, /start) then re-run.",
  );
  process.exit(0);
}

console.log(
  "discover-chat: found " + chats.size + " chat(s) the bot has seen:",
);
for (const [id, chat] of chats) {
  const label = chat.title ?? chat.username ?? chat.first_name ?? "?";
  console.log(`  chat_id=${id}  type=${chat.type}  name="${label}"`);
}
console.log(
  "\nTo enable live-tier tests, append to ~/.config/talon-tests/secrets.env:",
);
console.log("  TALON_TEST_CHAT_ID=" + Array.from(chats.keys())[0]);
