/**
 * Client diagnostics — the error/warn/disconnect/rate-limit listeners that
 * only log. discord.js handles reconnects and retries itself; these exist
 * so a silent failure mode (a fatal close code, an approaching IP ban) is
 * visible in the daemon log.
 */

import { type Client, Events } from "discord.js";
import { logError, logWarn } from "../../util/log.js";

function shardDisconnectLabel(code: number | undefined): string {
  return code === 4004
    ? "AUTHENTICATION_FAILED — bot token invalid/revoked"
    : code === 4013
      ? "INVALID_INTENTS — declared intent doesn't exist"
      : code === 4014
        ? "DISALLOWED_INTENTS — privileged intent (GuildMembers/MessageContent/Presence) not enabled in Developer Portal"
        : `code=${code}`;
}

export function bindClientDiagnostics(client: Client): void {
  client.on("error", (err) => {
    logError("discord", "Client error", err);
  });
  client.on("warn", (msg) => {
    logWarn("discord", msg);
  });

  // Surface gateway close codes — discord.js auto-reconnects on most, but
  // 4004 (auth failed), 4013 (invalid intents), 4014 (disallowed intents)
  // are terminal: the bot will hang silent in IDENTIFY without an alert.
  client.on(Events.ShardDisconnect, (event, shardId) => {
    const code = event?.code;
    const reason = event?.reason || "(no reason)";
    const fatal = code === 4004 || code === 4013 || code === 4014;
    const label = shardDisconnectLabel(code);
    if (fatal) {
      logError(
        "discord",
        `Shard ${shardId} disconnected fatally: ${label} (${reason})`,
      );
    } else {
      logWarn("discord", `Shard ${shardId} disconnected: ${label} (${reason})`);
    }
  });

  // Rate-limit / invalid-request observability. discord.js handles retries
  // automatically; we just want logs so we know when we're flirting with
  // the Cloudflare 10k-invalid-requests/10min cap.
  client.rest.on("rateLimited", (info) => {
    logWarn(
      "discord",
      `Rate-limited ${info.method} ${info.route} — wait ${info.timeToReset}ms (global=${info.global})`,
    );
  });
  client.rest.on("invalidRequestWarning", (info) => {
    logError(
      "discord",
      `Invalid-request warning: ${info.count} bad requests in last ${info.remainingTime}ms — approaching IP ban threshold`,
    );
  });
}
