/**
 * Access gates — the allow-lists are the entire permission model. DMs
 * match `allowedJids` (see connection/identity.ts); groups go through `groupPolicy`
 * and, in mention mode, must address the bot.
 */

import type { WAMessage } from "baileys";
import { logWarn } from "../../util/log.js";
import { bareId } from "./connection/identity.js";
import type { WhatsAppRuntime } from "./runtime.js";

/**
 * How long a group's membership answer is trusted. Group metadata costs a
 * round-trip, and the `with-allowed-user` policy would otherwise pay it on
 * every inbound message; memberships change on the order of days.
 */
const GROUP_POLICY_CACHE_MS = 10 * 60_000;

/**
 * May the bot act in this group? `allowedGroups` is always honoured;
 * beyond it the policy decides, and "with-allowed-user" asks WhatsApp
 * who is in the group (cached — see GROUP_POLICY_CACHE_MS).
 */
export async function isGroupAllowed(
  runtime: WhatsAppRuntime,
  jid: string,
): Promise<boolean> {
  if (runtime.allowedGroups.has(bareId(jid))) return true;
  if (runtime.settings.groupPolicy === "listed") return false;
  if (runtime.settings.groupPolicy === "all") return true;

  const cached = runtime.groupAllowCache.get(jid);
  if (cached && Date.now() - cached.at < GROUP_POLICY_CACHE_MS) {
    return cached.allowed;
  }
  let allowed = false;
  try {
    const meta = await runtime.sock!.groupMetadata(jid);
    // A participant is listed by whichever form the group uses, so
    // check every id WhatsApp gives us for them.
    allowed = meta.participants.some((p) =>
      [p.id, p.lid, p.phoneNumber]
        .filter((id): id is string => Boolean(id))
        .some((id) => runtime.allowedDms.has(bareId(id))),
    );
  } catch (err) {
    // A metadata failure must not silently open the group up.
    logWarn(
      "whatsapp",
      `Group policy check failed for ${jid}: ${err instanceof Error ? err.message : err}`,
    );
  }
  runtime.groupAllowCache.set(jid, { allowed, at: Date.now() });
  return allowed;
}

/** Is this group message addressed to us — @mentioned or quoting us? */
export function isAddressedToSelf(
  selfIds: readonly string[],
  msg: WAMessage,
): boolean {
  if (selfIds.length === 0) return false;
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const isSelf = (j: string): boolean => selfIds.includes(bareId(j));
  if ((ctx?.mentionedJid ?? []).some(isSelf)) return true;
  return Boolean(ctx?.participant && isSelf(ctx.participant));
}
