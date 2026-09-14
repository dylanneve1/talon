/**
 * Client connection lifecycle — login (blocking until READY) and the
 * shutdown sequence that takes the gateway down with the client.
 */

import { Events } from "discord.js";
import { once } from "node:events";
import { log, logError } from "../../util/log.js";
import type { DiscordRuntime } from "./runtime.js";

export async function connect(runtime: DiscordRuntime): Promise<void> {
  const { client, discord: dc } = runtime;
  await client.login(dc.botToken);
  // Wait for the WebSocket READY event before returning — login() resolves
  // after HTTP IDENTIFY but client.user / client.guilds.cache are empty
  // until READY fires. Anything called after start() can then safely read
  // gateway state.
  if (!client.isReady()) {
    await once(client, Events.ClientReady);
  }
}

export async function disconnect(runtime: DiscordRuntime): Promise<void> {
  try {
    await runtime.client.destroy();
    log("shutdown", "Discord client disconnected");
  } catch (err) {
    logError("shutdown", "Discord stop error", err);
  }
  try {
    await runtime.gateway.stop();
    log("shutdown", "Gateway stopped");
  } catch (err) {
    logError("shutdown", "Gateway stop error", err);
  }
}
