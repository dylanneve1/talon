/**
 * Shared helper functions extracted from userbot-actions.ts.
 * Used across all action category files.
 */

import { getClient } from "./client.js";
import type { ActionResult } from "../../../core/types.js";

/** Get client or return null if not connected. */
export function requireClient() {
  const client = getClient();
  if (!client) return null;
  return client;
}

/** Return standard "not connected" error */
export function notConnectedError(): ActionResult {
  return { ok: false, error: "User client not connected." };
}

/** Resolve peer from body.chat_id or use default */
export function peerFromBody(body: Record<string, unknown>, defaultPeer: number): number {
  return body.chat_id ? Number(body.chat_id) : defaultPeer;
}

/** Check if a peer ID represents a basic group (not supergroup/channel) */
export function isBasicGroup(peer: number): boolean {
  return peer < 0 && Math.abs(peer) < 1_000_000_000_000;
}

/** Generate a unique random ID for SendMedia/SendMessage */
export function randomId(): bigint {
  return BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000));
}

/** Extract reply_to message ID from body */
export function replyParams(body: Record<string, unknown>): number | undefined {
  const replyTo = body.reply_to ?? body.reply_to_message_id;
  return typeof replyTo === "number" && replyTo > 0 ? replyTo : undefined;
}

/** Extract message ID from GramJS Updates result */
export function extractMessageId(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  // UpdatesCombined / Updates: look for a message update
  const updates: unknown[] = r.updates ?? [];
  for (const upd of updates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = upd as any;
    if (u?.message?.id) return Number(u.message.id);
    if (typeof u?.id === "number") return u.id;
  }
  // UpdateShort
  if (r.update?.message?.id) return Number(r.update.message.id);
  return undefined;
}
