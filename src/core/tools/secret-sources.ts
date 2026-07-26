/**
 * Where the outbound secret scanner learns what the real secrets ARE.
 *
 * Layer 1 of `secret-scan.ts` matches literal credential values, which
 * means something has to enumerate them. That is I/O, and I/O has no
 * business running on the message send path, so it lives here: loaded
 * once, memoised for the life of the process, and always best-effort —
 * a missing or malformed source degrades the guard to layer 2 (patterns)
 * rather than breaking the ability to send messages.
 *
 * Sources, in the order they matter:
 *  - `~/.talon/config.json` — plugin env blocks and backend API keys.
 *  - `~/.talon/workspace/secrets/*` — the flat token files (one secret
 *    per file) the agent writes for itself.
 *  - the SSH plugin's `ssh-servers.json` — passwords and key material for
 *    the boxes on the mesh. This is the file behind the real incident:
 *    a Raspberry Pi password read from here and pasted into a group.
 *
 * NOTE: this module deliberately never logs, returns or formats a secret
 * value. It hands an opaque list to the scanner and nothing else.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { dirs, files } from "../../util/paths.js";

/** Anything shorter than this is noise, not a credential. */
const MIN_LENGTH = 8;

/**
 * Keys whose values are credentials. Matched case-insensitively as a
 * substring, so `ANTHROPIC_API_KEY`, `botToken` and `ssh_password` all
 * qualify without needing an exhaustive list.
 */
const SECRET_KEY_HINTS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "privatekey",
  "apikey",
];

function looksLikeSecretKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SECRET_KEY_HINTS.some((hint) => lowered.includes(hint));
}

/** Walk arbitrary JSON, collecting values held under credential-ish keys. */
function harvestJson(value: unknown, out: Set<string>, keyIsSecret = false) {
  if (typeof value === "string") {
    if (keyIsSecret && value.trim().length >= MIN_LENGTH) out.add(value.trim());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) harvestJson(item, out, keyIsSecret);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      harvestJson(item, out, keyIsSecret || looksLikeSecretKey(key));
    }
  }
}

function harvestJsonFile(path: string, out: Set<string>) {
  try {
    harvestJson(JSON.parse(readFileSync(path, "utf8")), out);
  } catch {
    // Missing or malformed: fall through to the other sources.
  }
}

/**
 * The workspace `secrets/` directory holds one credential per file, with
 * the whole file body being the value. Read shallowly and cap the size —
 * a big file there is a keystore or a cert bundle, not a token, and
 * substring-matching megabytes on every send would be a real cost.
 */
const MAX_SECRET_FILE_BYTES = 4096;

function harvestSecretsDir(dir: string, out: Set<string>) {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = resolve(dir, entry);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_SECRET_FILE_BYTES) continue;
      const body = readFileSync(path, "utf8").trim();
      if (body.length >= MIN_LENGTH && !body.includes("\n")) out.add(body);
    } catch {
      continue;
    }
  }
}

let cached: readonly string[] | undefined;

/**
 * Every literal secret value this host knows about. Memoised — call it
 * freely on the send path.
 *
 * Sorted longest-first so that when a value is a prefix of another the
 * more specific one is reported; the scanner short-circuits per rule, and
 * this keeps that deterministic.
 */
export function knownSecretValues(): readonly string[] {
  if (cached) return cached;
  const out = new Set<string>();

  harvestJsonFile(files.config, out);
  harvestSecretsDir(resolve(dirs.workspace, "secrets"), out);
  harvestJsonFile(
    resolve(homedir(), "talon.plugins.ssh", "ssh-servers.json"),
    out,
  );

  cached = [...out].sort((a, b) => b.length - a.length);
  return cached;
}

/** Drop the memoised list (tests, and after a credential rotation). */
export function resetKnownSecretValues(): void {
  cached = undefined;
}
