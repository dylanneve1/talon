/**
 * Group administration — the `moderate` tool's op switch.
 *
 * WhatsApp's admin model is narrower than Telegram's: there is no ban
 * list (removal is the only eviction), no per-member mute (a group is
 * either open or admins-only), and no forum topics. Ops that have a
 * faithful WhatsApp equivalent are mapped to it; the rest report what
 * WhatsApp actually offers instead, so the model can pick another route
 * rather than retrying something the platform cannot do.
 */

import { toUserJid, tryAction } from "./shared.js";
import type { WhatsAppActionHandlers } from "./types.js";

/** Ops that act on one member. */
const PARTICIPANT_OPS: Record<string, "remove" | "add" | "promote" | "demote"> =
  {
    ban: "remove",
    kick: "remove",
    remove: "remove",
    unban: "add",
    add: "add",
    promote: "promote",
    demote: "demote",
  };

export const moderationHandlers: WhatsAppActionHandlers = {
  moderate: (body, _chatId, ctx) =>
    tryAction("moderate", async () => {
      const op = String(body.op ?? "");
      const chat = ctx.chat!;
      const { sock } = ctx;

      const participantOp = PARTICIPANT_OPS[op];
      if (participantOp) {
        if (!chat.isGroup) {
          return { ok: false, error: `moderate(${op}) only applies to groups` };
        }
        const jid = toUserJid(body.user_id);
        if (!jid) {
          return { ok: false, error: `moderate(${op}) requires user_id` };
        }
        const [result] = await sock.groupParticipantsUpdate(
          chat.jid,
          [jid],
          participantOp,
        );
        // Baileys reports per-participant status codes rather than throwing:
        // 403 is "privacy settings blocked the add", 408 "not on WhatsApp".
        const status = String(result?.status ?? "200");
        if (status !== "200") {
          return {
            ok: false,
            error: `WhatsApp refused ${op} for ${jid} (status ${status})`,
          };
        }
        return {
          ok: true,
          text:
            op === "ban"
              ? `Removed ${jid} — WhatsApp has no ban list, so they can rejoin via an invite.`
              : `${op} applied to ${jid}`,
        };
      }

      switch (op) {
        case "mute":
        case "set_permissions": {
          if (!chat.isGroup) {
            return {
              ok: false,
              error: `moderate(${op}) only applies to groups`,
            };
          }
          if (body.user_id) {
            return {
              ok: false,
              error:
                "WhatsApp has no per-member mute — mute the whole group " +
                "(admins-only mode) or remove the member.",
            };
          }
          // Announcement mode is WhatsApp's whole-group mute.
          const permissions = (body.permissions ?? {}) as {
            send_messages?: boolean;
          };
          const open =
            op === "mute" ? false : permissions.send_messages !== false;
          await sock.groupSettingUpdate(
            chat.jid,
            open ? "not_announcement" : "announcement",
          );
          return {
            ok: true,
            text: open
              ? "All members can send messages."
              : "Only admins can send messages.",
          };
        }

        case "unmute": {
          if (!chat.isGroup) {
            return {
              ok: false,
              error: "moderate(unmute) only applies to groups",
            };
          }
          await sock.groupSettingUpdate(chat.jid, "not_announcement");
          return { ok: true, text: "All members can send messages." };
        }

        case "create_invite_link": {
          if (!chat.isGroup) {
            return { ok: false, error: "Only groups have invite links" };
          }
          const code = await sock.groupInviteCode(chat.jid);
          return { ok: true, text: `https://chat.whatsapp.com/${code}` };
        }

        case "revoke_invite_link": {
          if (!chat.isGroup) {
            return { ok: false, error: "Only groups have invite links" };
          }
          const code = await sock.groupRevokeInvite(chat.jid);
          return {
            ok: true,
            text: `Old link revoked. New link: https://chat.whatsapp.com/${code}`,
          };
        }

        case "list_join_requests": {
          if (!chat.isGroup) {
            return { ok: false, error: "Only groups have join requests" };
          }
          const requests = await sock.groupRequestParticipantsList(chat.jid);
          return {
            ok: true,
            text: requests.length
              ? requests
                  .map(
                    (r) =>
                      `${String(r.jid).split("@")[0]} (${r.request_method ?? "?"})`,
                  )
                  .join("\n")
              : "No pending join requests.",
          };
        }

        case "approve_join_request":
        case "decline_join_request": {
          if (!chat.isGroup) {
            return { ok: false, error: "Only groups have join requests" };
          }
          const jid = toUserJid(body.user_id);
          if (!jid) {
            return { ok: false, error: `moderate(${op}) requires user_id` };
          }
          await sock.groupRequestParticipantsUpdate(
            chat.jid,
            [jid],
            op === "approve_join_request" ? "approve" : "reject",
          );
          return { ok: true };
        }

        case "set_chat_photo": {
          const source = body.file_path ?? body.url;
          if (!source) {
            return {
              ok: false,
              error: "moderate(set_chat_photo) requires file_path or url",
            };
          }
          await sock.updateProfilePicture(chat.jid, { url: String(source) });
          return { ok: true };
        }

        case "delete_chat_photo":
          await sock.removeProfilePicture(chat.jid);
          return { ok: true };

        case "leave_chat": {
          if (!chat.isGroup) {
            return {
              ok: false,
              error:
                "Cannot leave a direct message — block the contact instead",
            };
          }
          await sock.groupLeave(chat.jid);
          return { ok: true };
        }

        case "unpin_all": {
          // WhatsApp unpins individually; clear the ones Talon placed.
          const { listPins } = await import("../pins.js");
          const pins = listPins(chat.chatId);
          return {
            ok: true,
            text:
              pins.length === 0
                ? "No Talon-placed pins to clear."
                : `WhatsApp unpins one message at a time — call unpin_message for: ${pins
                    .map((p) => p.msgId)
                    .join(", ")}`,
          };
        }

        case "set_admin_title":
          return {
            ok: false,
            error: "WhatsApp has no custom admin titles",
          };

        case "create_topic":
        case "edit_topic":
        case "close_topic":
        case "reopen_topic":
        case "delete_topic":
          return {
            ok: false,
            error:
              "WhatsApp groups have no topics — use separate groups, or a " +
              "community with sub-groups (not manageable from this account).",
          };

        default:
          return { ok: false, error: `Unknown moderate op: ${op}` };
      }
    }),
};
