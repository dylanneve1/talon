/**
 * Account actions — the bot's own WhatsApp identity and settings.
 *
 * Everything here addresses the logged-in account rather than a chat:
 * display name, about text, profile photo, privacy knobs, the
 * blocklist, and presence. That makes these the only WhatsApp actions
 * with no chat to resolve, so the dispatcher treats them as chatless —
 * which is also what lets them be driven from another frontend (a
 * Telegram session managing the WhatsApp account) with no ambient
 * WhatsApp chat in play.
 *
 * One `whatsapp_account` action with an `op` switch, mirroring
 * `moderate`: the surface is wide but every op is small, and a single
 * tool keeps the model from having to learn a dozen names.
 */

import { jidNormalizedUser, type WASocket } from "baileys";
import type { ActionResult } from "../../../core/types.js";
import {
  readStatusText,
  resolveMediaUpload,
  toUserJid,
  tryAction,
} from "./shared.js";
import type { WhatsAppActionContext, WhatsAppActionHandlers } from "./types.js";

/** The account's own JID, device suffix stripped. */
function ownJid(sock: WASocket): string {
  const raw = sock.user?.id;
  if (!raw) throw new Error("not logged in — no account JID yet");
  return jidNormalizedUser(raw);
}

/**
 * The privacy knobs WhatsApp exposes, each with its accepted values and
 * the setter it maps to. Table-driven so `set_privacy` stays one lookup
 * and an unknown setting can name every valid one back.
 */
const PRIVACY: Record<
  string,
  {
    values: readonly string[];
    apply: (sock: WASocket, v: string) => Promise<void>;
  }
> = {
  last_seen: {
    values: ["all", "contacts", "contact_blacklist", "none"],
    apply: (s, v) => s.updateLastSeenPrivacy(v as "all"),
  },
  online: {
    values: ["all", "match_last_seen"],
    apply: (s, v) => s.updateOnlinePrivacy(v as "all"),
  },
  profile_photo: {
    values: ["all", "contacts", "contact_blacklist", "none"],
    apply: (s, v) => s.updateProfilePicturePrivacy(v as "all"),
  },
  about: {
    values: ["all", "contacts", "contact_blacklist", "none"],
    apply: (s, v) => s.updateStatusPrivacy(v as "all"),
  },
  read_receipts: {
    values: ["all", "none"],
    apply: (s, v) => s.updateReadReceiptsPrivacy(v as "all"),
  },
  groups_add: {
    values: ["all", "contacts", "contact_blacklist"],
    apply: (s, v) => s.updateGroupsAddPrivacy(v as "all"),
  },
  calls: {
    values: ["all", "known"],
    apply: (s, v) => s.updateCallPrivacy(v as "all"),
  },
  messages: {
    values: ["all", "contacts"],
    apply: (s, v) => s.updateMessagesPrivacy(v as "all"),
  },
};

/** Named durations for the default disappearing-message timer. */
const DISAPPEARING: Record<string, number> = {
  off: 0,
  "24h": 86400,
  "7d": 604800,
  "90d": 7776000,
};

type Op = (
  body: Record<string, unknown>,
  ctx: WhatsAppActionContext,
) => Promise<ActionResult>;

/** Whole own-profile read: who this account is, as WhatsApp sees it. */
const getProfile: Op = async (_body, ctx) => {
  const jid = ownJid(ctx.sock);
  const lines = [
    `jid: ${jid}`,
    `number: +${jid.split("@")[0]}`,
    `name: ${ctx.sock.user?.name ?? "(unset)"}`,
  ];
  // Both reads are best-effort: a fresh account has neither, and the
  // account's own privacy settings never hide them from itself.
  const status = await ctx.sock.fetchStatus(jid).catch(() => undefined);
  lines.push(`about: ${readStatusText(status) ?? "(unset)"}`);
  const photo = await ctx.sock
    .profilePictureUrl(jid, "image")
    .catch(() => undefined);
  lines.push(`photo: ${photo ?? "(none)"}`);
  return { ok: true, text: lines.join("\n") };
};

/** Another account's public card — what strangers see of them. */
const getUserProfile: Op = async (body, ctx) => {
  const jid = toUserJid(body.contact ?? body.user_id);
  if (!jid) {
    return { ok: false, error: "get_user_profile: contact is required" };
  }
  const status = await ctx.sock.fetchStatus(jid).catch(() => undefined);
  const photo = await ctx.sock
    .profilePictureUrl(jid, "image")
    .catch(() => undefined);
  return {
    ok: true,
    text: [
      `jid: ${jid}`,
      `about: ${readStatusText(status) ?? "(hidden or unset)"}`,
      `photo: ${photo ?? "(hidden or none)"}`,
    ].join("\n"),
  };
};

const setName: Op = async (body, ctx) => {
  const name = String(body.name ?? "").trim();
  if (!name) return { ok: false, error: "set_name: name is required" };
  await ctx.sock.updateProfileName(name);
  return { ok: true, text: `Display name set to "${name}".` };
};

const setAbout: Op = async (body, ctx) => {
  // An empty string is a legitimate value here — it clears the about.
  const text = String(body.text ?? body.about ?? "");
  await ctx.sock.updateProfileStatus(text);
  return {
    ok: true,
    text: text ? `About set to "${text}".` : "About cleared.",
  };
};

const setPhoto: Op = async (body, ctx) => {
  const resolved = resolveMediaUpload(body, "set_photo");
  if ("error" in resolved) return { ok: false, error: resolved.error };
  await ctx.sock.updateProfilePicture(ownJid(ctx.sock), resolved.media);
  return { ok: true, text: "Profile photo updated." };
};

const removePhoto: Op = async (_body, ctx) => {
  await ctx.sock.removeProfilePicture(ownJid(ctx.sock));
  return { ok: true, text: "Profile photo removed." };
};

const getPrivacy: Op = async (_body, ctx) => {
  const settings = await ctx.sock.fetchPrivacySettings(true);
  const rows = Object.entries(settings).map(([k, v]) => `${k}: ${v}`);
  return {
    ok: true,
    text: rows.length ? rows.join("\n") : "No privacy settings reported.",
  };
};

const setPrivacy: Op = async (body, ctx) => {
  const setting = String(body.setting ?? "")
    .trim()
    .toLowerCase();
  const knob = Object.hasOwn(PRIVACY, setting) ? PRIVACY[setting] : undefined;
  if (!knob) {
    return {
      ok: false,
      error: `set_privacy: unknown setting "${setting}" — use one of ${Object.keys(PRIVACY).join(", ")}`,
    };
  }
  const value = String(body.value ?? "")
    .trim()
    .toLowerCase();
  if (!knob.values.includes(value)) {
    return {
      ok: false,
      error: `set_privacy: ${setting} accepts ${knob.values.join(", ")} (got "${value}")`,
    };
  }
  await knob.apply(ctx.sock, value);
  return { ok: true, text: `Privacy ${setting} set to ${value}.` };
};

const setDisappearing: Op = async (body, ctx) => {
  const raw = String(body.duration ?? "")
    .trim()
    .toLowerCase();
  const seconds = Object.hasOwn(DISAPPEARING, raw)
    ? DISAPPEARING[raw]
    : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return {
      ok: false,
      error: `set_disappearing: duration must be seconds, or one of ${Object.keys(DISAPPEARING).join(", ")}`,
    };
  }
  await ctx.sock.updateDefaultDisappearingMode(seconds);
  return {
    ok: true,
    text: seconds
      ? `New chats now disappear after ${seconds}s.`
      : "Disappearing messages off for new chats.",
  };
};

const getBlocklist: Op = async (_body, ctx) => {
  const blocked = (await ctx.sock.fetchBlocklist()).filter(Boolean);
  return {
    ok: true,
    text: blocked.length ? blocked.join("\n") : "Blocklist is empty.",
  };
};

/** block / unblock share everything but the verb. */
function blockOp(action: "block" | "unblock"): Op {
  return async (body, ctx) => {
    const jid = toUserJid(body.contact ?? body.user_id);
    if (!jid) return { ok: false, error: `${action}: contact is required` };
    await ctx.sock.updateBlockStatus(jid, action);
    return { ok: true, text: `${jid} ${action}ed.` };
  };
}

const setPresence: Op = async (body, ctx) => {
  const state = String(body.presence ?? body.state ?? "")
    .trim()
    .toLowerCase();
  if (state !== "available" && state !== "unavailable") {
    return {
      ok: false,
      error: 'set_presence: presence must be "available" or "unavailable"',
    };
  }
  await ctx.sock.sendPresenceUpdate(state);
  return { ok: true, text: `Presence set to ${state}.` };
};

const OPS: Record<string, Op> = {
  get_profile: getProfile,
  get_user_profile: getUserProfile,
  set_name: setName,
  set_about: setAbout,
  set_photo: setPhoto,
  remove_photo: removePhoto,
  get_privacy: getPrivacy,
  set_privacy: setPrivacy,
  set_disappearing: setDisappearing,
  get_blocklist: getBlocklist,
  block: blockOp("block"),
  unblock: blockOp("unblock"),
  set_presence: setPresence,
};

/** Every op name, for the "unknown op" error to list back. */
const ACCOUNT_OPS: readonly string[] = Object.keys(OPS);

export const accountHandlers: WhatsAppActionHandlers = {
  whatsapp_account: (body, _chatId, ctx) =>
    tryAction("whatsapp_account", async () => {
      const op = String(body.op ?? "")
        .trim()
        .toLowerCase();
      const run = Object.hasOwn(OPS, op) ? OPS[op] : undefined;
      if (!run) {
        return {
          ok: false,
          error: `whatsapp_account: unknown op "${op}" — use one of ${ACCOUNT_OPS.join(", ")}`,
        };
      }
      return run(body, ctx);
    }),
};
