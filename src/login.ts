#!/usr/bin/env node
/**
 * One-time login script for the GramJS user session.
 * Run: npx tsx src/login.ts
 *
 * You'll need:
 * - TALON_API_ID and TALON_API_HASH from https://my.telegram.org
 * - Your phone number (will receive a login code via Telegram)
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { files } from "./util/paths.js";

// Load .env
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
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
    if (!process.env[key]) process.env[key] = value;
  }
}

const SESSION_FILE = files.userSession;

const apiId = parseInt(process.env.TALON_API_ID || "", 10);
const apiHash = process.env.TALON_API_HASH || "";

if (!apiId || !apiHash) {
  console.error("Set TALON_API_ID and TALON_API_HASH in .env");
  console.error(
    "Get them from https://my.telegram.org → API development tools",
  );
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

async function main() {
  let sessionString = "";
  if (existsSync(SESSION_FILE)) {
    sessionString = readFileSync(SESSION_FILE, "utf-8").trim();
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await ask("Phone number (with country code): "),
    password: async () => await ask("2FA password (if enabled): "),
    phoneCode: async () => await ask("Login code from Telegram: "),
    onError: (err) => console.error("Login error:", err),
  });

  console.log("\nLogged in successfully!");

  // Save session
  const newSession = client.session.save() as unknown as string;
  const dir = dirname(SESSION_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSION_FILE, newSession);
  console.log(`Session saved to ${SESSION_FILE}`);

  await client.disconnect();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
