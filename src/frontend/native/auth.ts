/**
 * Bridge auth token — the shared secret behind every non-/health route.
 *
 * The operator can set one explicitly (`native.token`); this module covers
 * the case where they didn't but the bridge is about to bind a non-loopback
 * host. Serving the full agent API unauthenticated to the LAN is never an
 * acceptable default, so a token is minted once and persisted under
 * ~/.talon/keys/ — stable across restarts so paired clients keep working.
 *
 * The token value itself never goes to the log (SECURITY.md treats
 * credentials in logs as a vulnerability); same-machine clients pick it up
 * from the 0600 discovery file, remote clients read it from the key file.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import { log } from "../../util/log.js";

const TOKEN_FILE = "bridge-token";
/** 32 random bytes → 43 base64url chars; comfortably beyond brute force. */
const TOKEN_BYTES = 32;

/** Path of the persisted token, for operator-facing messages. */
export function bridgeTokenPath(dir: string = dirs.keys): string {
  return resolve(dir, TOKEN_FILE);
}

/**
 * Load the persisted auto-generated bridge token, minting it on first use.
 * Lives under ~/.talon/keys/ with owner-only permissions, like the TLS
 * identity next to it.
 */
export function loadOrCreateBridgeToken(dir: string = dirs.keys): string {
  const path = bridgeTokenPath(dir);
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // first boot — nothing persisted yet
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // mode above is ignored when the file exists
  log(
    "native",
    `Minted bridge auth token (non-loopback bind with no native.token) — pair remote clients with the value in ${path}`,
  );
  return token;
}
