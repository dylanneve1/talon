/**
 * GramJS-based action handler for userbot primary mode.
 *
 * Mirrors the shape of createTelegramActionHandler() in actions.ts but uses
 * the GramJS user client instead of the Grammy Bot API.  All read-only
 * userbot operations (history, search, participants …) already live in
 * userbot.ts and are delegated there unchanged.
 *
 * User accounts have access to many more APIs than bots — this file implements
 * the full surface: profile management, chat admin ops, member management,
 * sticker set creation, stories, contacts, polls, locations, and more.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { CustomFile } from "telegram/client/uploads.js";
import { Api } from "telegram";
import {
  isUserClientReady,
  sendUserbotMessage,
  sendUserbotTyping,
  editUserbotMessage,
  deleteUserbotMessage,
  reactUserbotMessage,
  clearUserbotReactions,
  pinUserbotMessage,
  unpinUserbotMessage,
  forwardUserbotMessage,
  sendUserbotFile,
  getUserbotEntity,
  getUserbotAdmins,
  getUserbotMemberCount,
  searchMessages as userbotSearch,
  getHistory as userbotHistory,
  getParticipantDetails as userbotParticipantDetails,
  getUserInfo as userbotGetUserInfo,
  getMessage as userbotGetMessage,
  getPinnedMessages as userbotPinnedMessages,
  getOnlineCount as userbotOnlineCount,
  downloadMessageMedia,
  getClient,
} from "./userbot.js";
import { withRetry } from "../../core/gateway.js";
import type { Gateway } from "../../core/gateway.js";
import type { ActionResult } from "../../core/types.js";

const TELEGRAM_MAX_TEXT = 4096;

// ── Scheduled message state ──────────────────────────────────────────────────

type ScheduledEntry = ReturnType<typeof setTimeout>;
const scheduledMessages = new Map<string, ScheduledEntry>();

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a GramJS-based action handler.
 * The `recordOurMessage` callback is provided by userbot-frontend so that
 * messages we send can be tracked for reply-to-self detection.
 */
export function createUserbotActionHandler(
  gateway: Gateway,
  recordOurMessage: (chatId: string, msgId: number) => void,
) {
  return async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const peer = chatId; // GramJS accepts numeric peer IDs directly
    const chatIdStr = String(chatId);

    switch (action) {
      // ── Messaging ─────────────────────────────────────────────────────────

      case "send_message": {
        const text = String(body.text ?? "");
        const replyTo = typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : undefined;
        gateway.incrementMessages(chatId);
        const msgId = await withRetry(() => sendUserbotMessage(peer, text, replyTo));
        recordOurMessage(chatIdStr, msgId);
        return { ok: true, message_id: msgId };
      }

      case "reply_to": {
        const replyToId = Number(body.message_id);
        const text = String(body.text ?? "");
        gateway.incrementMessages(chatId);
        const msgId = await withRetry(() => sendUserbotMessage(peer, text, replyToId));
        recordOurMessage(chatIdStr, msgId);
        return { ok: true, message_id: msgId };
      }

      case "react": {
        const emoji = String(body.emoji ?? "👍");
        const msgId = Number(body.message_id);
        await withRetry(() => reactUserbotMessage(peer, msgId, emoji));
        return { ok: true };
      }

      case "clear_reactions": {
        const msgId = Number(body.message_id);
        await clearUserbotReactions(peer, msgId);
        return { ok: true };
      }

      case "edit_message": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT)
          return { ok: false, error: `Text too long (max ${TELEGRAM_MAX_TEXT})` };
        await withRetry(() => editUserbotMessage(peer, Number(body.message_id), text));
        return { ok: true };
      }

      case "delete_message":
        await deleteUserbotMessage(peer, Number(body.message_id));
        return { ok: true };

      case "pin_message":
        await pinUserbotMessage(peer, Number(body.message_id));
        return { ok: true };

      case "unpin_message":
        await unpinUserbotMessage(
          peer,
          body.message_id ? Number(body.message_id) : undefined,
        );
        return { ok: true };

      case "forward_message": {
        if (body.to_chat_id && Number(body.to_chat_id) !== chatId)
          return { ok: false, error: "Cross-chat forwarding not allowed." };
        const sentId = await forwardUserbotMessage(peer, Number(body.message_id));
        return { ok: true, message_id: sentId };
      }

      // copy_message: forward without attribution (same effect in user mode)
      case "copy_message": {
        const sentId = await forwardUserbotMessage(peer, Number(body.message_id));
        return { ok: true, message_id: sentId };
      }

      case "send_chat_action":
        await sendUserbotTyping(peer);
        return { ok: true };

      case "schedule_message": {
        const text = String(body.text ?? "");
        const delaySec = Math.max(1, Math.min(3600, Number(body.delay_seconds ?? 60)));
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(async () => {
          try {
            const msgId = await sendUserbotMessage(peer, text);
            recordOurMessage(chatIdStr, msgId);
          } catch { /* scheduled send failed */ }
          scheduledMessages.delete(scheduleId);
        }, delaySec * 1000);
        scheduledMessages.set(scheduleId, timer);
        return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
      }

      case "cancel_scheduled": {
        const timer = scheduledMessages.get(String(body.schedule_id ?? ""));
        if (timer) {
          clearTimeout(timer);
          scheduledMessages.delete(String(body.schedule_id));
          return { ok: true, cancelled: true };
        }
        return { ok: false, error: "Schedule not found" };
      }

      // Inline keyboards with callback_data are bot-only — send as plain text
      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT)
          return { ok: false, error: "Text too long" };
        gateway.incrementMessages(chatId);
        const msgId = await withRetry(() => sendUserbotMessage(peer, text));
        recordOurMessage(chatIdStr, msgId);
        return { ok: true, message_id: msgId, warning: "Inline keyboard buttons are not supported in user mode — message sent without buttons." };
      }

      // send_dice is bot-only (InputMediaDice not available to user accounts)
      case "send_dice":
        return { ok: false, error: "send_dice is only available to bots, not user accounts." };

      // ── Media ──────────────────────────────────────────────────────────────

      case "send_file":
      case "send_photo":
      case "send_video":
      case "send_animation":
      case "send_voice":
      case "send_audio": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        if (action === "send_file") {
          const stat = statSync(filePath);
          if (stat.size > 2000 * 1024 * 1024)
            return { ok: false, error: "File too large for Telegram (max 2GB)" };
        }
        gateway.incrementMessages(chatId);
        const type = action === "send_file" ? "document"
          : action === "send_photo" ? "photo"
          : action === "send_video" ? "video"
          : action === "send_animation" ? "animation"
          : action === "send_voice" ? "voice"
          : "audio";
        const msgId = await withRetry(() =>
          sendUserbotFile(peer, {
            filePath,
            caption,
            replyTo: replyParams(body),
            type,
            title: body.title as string | undefined,
            performer: body.performer as string | undefined,
          }),
        );
        recordOurMessage(chatIdStr, msgId);
        return { ok: true, message_id: msgId };
      }

      case "send_sticker":
        return { ok: false, error: "send_sticker with file_id is not supported in user mode. Use send_file with a local sticker file path (.webp / .tgs)." };

      case "send_poll": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const question = String(body.question ?? "");
        const rawOptions = body.options;
        if (!Array.isArray(rawOptions) || rawOptions.length < 2)
          return { ok: false, error: "send_poll requires at least 2 options (array)" };

        const pollAnswers = (rawOptions as unknown[]).map((opt, i) =>
          new Api.PollAnswer({
            text: new Api.TextWithEntities({ text: String(opt), entities: [] }),
            option: Buffer.from([i]),
          }),
        );

        const isQuiz = body.is_quiz === true;
        const isAnonymous = body.is_anonymous !== false; // default true
        const allowsMultiple = body.allows_multiple_answers === true;
        const correctOption = typeof body.correct_option_id === "number" ? body.correct_option_id : undefined;

        const poll = new Api.Poll({
          id: BigInt(0) as unknown as import("big-integer").BigInteger,
          question: new Api.TextWithEntities({ text: question, entities: [] }),
          answers: pollAnswers,
          quiz: isQuiz || undefined,
          publicVoters: isAnonymous ? undefined : true,
          multipleChoice: allowsMultiple || undefined,
          closePeriod: typeof body.open_period === "number" ? body.open_period : undefined,
        });

        const pollResults = isQuiz && correctOption !== undefined
          ? new Api.PollResults({
              results: [],
              solution: body.explanation ? String(body.explanation) : undefined,
            })
          : undefined;

        const media = new Api.InputMediaPoll({
          poll,
          correctAnswers: isQuiz && correctOption !== undefined
            ? [Buffer.from([correctOption])]
            : undefined,
          solution: pollResults?.solution,
          solutionEntities: [],
        });

        gateway.incrementMessages(chatId);
        const sendResult = await withRetry(() =>
          client!.invoke(new Api.messages.SendMedia({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            media,
            message: "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            randomId: BigInt(Date.now()) as any,
          })),
        );
        const pollMsgId = extractMessageId(sendResult);
        if (pollMsgId) recordOurMessage(chatIdStr, pollMsgId);
        return { ok: true, message_id: pollMsgId };
      }

      case "send_location": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const lat = Number(body.latitude ?? body.lat ?? 0);
        const long = Number(body.longitude ?? body.lng ?? body.long ?? 0);
        if (!lat && !long) return { ok: false, error: "latitude and longitude are required" };

        const media = new Api.InputMediaGeoPoint({
          geoPoint: new Api.InputGeoPoint({ lat, long }),
        });

        gateway.incrementMessages(chatId);
        const sendResult = await withRetry(() =>
          client!.invoke(new Api.messages.SendMedia({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            media,
            message: body.caption ? String(body.caption) : "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            randomId: BigInt(Date.now()) as any,
          })),
        );
        const locMsgId = extractMessageId(sendResult);
        if (locMsgId) recordOurMessage(chatIdStr, locMsgId);
        return { ok: true, message_id: locMsgId };
      }

      case "send_contact": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const phoneNumber = String(body.phone_number ?? "");
        const firstName = String(body.first_name ?? "");
        const lastName = String(body.last_name ?? "");
        const vcard = body.vcard ? String(body.vcard) : "";

        if (!phoneNumber || !firstName)
          return { ok: false, error: "phone_number and first_name are required" };

        const media = new Api.InputMediaContact({
          phoneNumber,
          firstName,
          lastName,
          vcard,
        });

        gateway.incrementMessages(chatId);
        const sendResult = await withRetry(() =>
          client!.invoke(new Api.messages.SendMedia({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            media,
            message: "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            randomId: BigInt(Date.now()) as any,
          })),
        );
        const contactMsgId = extractMessageId(sendResult);
        if (contactMsgId) recordOurMessage(chatIdStr, contactMsgId);
        return { ok: true, message_id: contactMsgId };
      }

      case "send_album": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const rawPaths = body.file_paths;
        if (!Array.isArray(rawPaths) || rawPaths.length === 0)
          return { ok: false, error: "file_paths must be a non-empty array" };
        if (rawPaths.length > 10)
          return { ok: false, error: "Albums can have at most 10 items" };

        const filePaths = (rawPaths as unknown[]).map(String);
        const caption = body.caption ? String(body.caption) : undefined;

        gateway.incrementMessages(chatId);
        // GramJS sendFile with an array of paths sends as an album
        const sent = await withRetry(() =>
          client!.sendFile(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer as any,
            {
              file: filePaths,
              caption: caption ?? "",
              parseMode: caption ? "html" : undefined,
            },
          ),
        );
        // sendFile returns a single Message or array; grab the first id
        const albumMsgId = Array.isArray(sent) ? (sent[0] as { id?: number })?.id : (sent as { id?: number })?.id;
        if (albumMsgId) recordOurMessage(chatIdStr, albumMsgId);
        return { ok: true, message_id: albumMsgId };
      }

      // ── Profile management ─────────────────────────────────────────────────

      case "get_my_profile": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const me = await client.getMe() as any;
        return {
          ok: true,
          id: Number(me.id),
          first_name: me.firstName ?? null,
          last_name: me.lastName ?? null,
          username: me.username ?? null,
          phone: me.phone ?? null,
          bio: me.about ?? null,
          verified: me.verified ?? false,
          premium: me.premium ?? false,
          bot: me.bot ?? false,
        };
      }

      case "edit_profile": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const updateParams: Record<string, string> = {};
        if (typeof body.first_name === "string") updateParams.firstName = body.first_name;
        if (typeof body.last_name === "string") updateParams.lastName = body.last_name;
        if (typeof body.about === "string") updateParams.about = body.about;

        if (Object.keys(updateParams).length === 0)
          return { ok: false, error: "Provide at least one of: first_name, last_name, about" };

        await withRetry(() =>
          client!.invoke(new Api.account.UpdateProfile(updateParams)),
        );
        return { ok: true };
      }

      case "set_username": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const username = String(body.username ?? "");
        await withRetry(() =>
          client!.invoke(new Api.account.UpdateUsername({ username })),
        );
        return { ok: true };
      }

      case "set_profile_photo": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const filePath = String(body.file_path ?? "");
        if (!filePath) return { ok: false, error: "file_path is required" };

        const fileSize = statSync(filePath).size;
        const uploaded = await withRetry(() =>
          client!.uploadFile({ file: new CustomFile(basename(filePath), fileSize, filePath), workers: 1 }),
        );
        await withRetry(() =>
          client!.invoke(new Api.photos.UploadProfilePhoto({
            file: uploaded,
          })),
        );
        return { ok: true };
      }

      case "delete_profile_photos": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const photosResult = await client.invoke(new Api.photos.GetUserPhotos({
          userId: new Api.InputUserSelf(),
          offset: 0,
          maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
          limit: 100,
        })) as any;

        const photos: unknown[] = photosResult.photos ?? [];
        if (photos.length === 0) return { ok: true, deleted: 0 };

        await withRetry(() =>
          client!.invoke(new Api.photos.DeletePhotos({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            id: (photos as any[]).map((p: any) =>
              new Api.InputPhoto({ id: p.id, accessHash: p.accessHash, fileReference: p.fileReference }),
            ),
          })),
        );
        return { ok: true, deleted: photos.length };
      }

      // ── Chat management ────────────────────────────────────────────────────

      case "get_chat_info": {
        const info = await getUserbotEntity(peer);
        const count = await getUserbotMemberCount(peer).catch(() => null);
        return { ok: true, ...info, member_count: count };
      }

      case "get_chat_member": {
        const userId = Number(body.user_id);
        const result = await userbotGetUserInfo({ chatId, userId }).catch((e) => String(e));
        return { ok: true, text: result };
      }

      case "get_chat_admins": {
        const text = await getUserbotAdmins(peer);
        return { ok: true, text };
      }

      case "get_chat_member_count": {
        const count = await getUserbotMemberCount(peer);
        return { ok: true, count };
      }

      case "set_chat_title": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const title = String(body.title ?? "");
        if (!title) return { ok: false, error: "title is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = await client.getEntity(peer as any) as any;
        const isChannel = entity.className === "Channel";

        if (isChannel) {
          await withRetry(() =>
            client!.invoke(new Api.channels.EditTitle({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: peer as any,
              title,
            })),
          );
        } else {
          await withRetry(() =>
            client!.invoke(new Api.messages.EditChatTitle({
              chatId: BigInt(peer) as unknown as import("big-integer").BigInteger,
              title,
            })),
          );
        }
        return { ok: true };
      }

      case "set_chat_description": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const about = String(body.description ?? body.about ?? "");
        await withRetry(() =>
          client!.invoke(new Api.messages.EditChatAbout({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            about,
          })),
        );
        return { ok: true };
      }

      case "set_chat_photo": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const filePath = String(body.file_path ?? "");
        if (!filePath) return { ok: false, error: "file_path is required" };

        const chatPhotoSize = statSync(filePath).size;
        const uploaded = await withRetry(() =>
          client!.uploadFile({ file: new CustomFile(basename(filePath), chatPhotoSize, filePath), workers: 1 }),
        );
        const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded });
        await withRetry(() =>
          client!.invoke(new Api.channels.EditPhoto({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            photo: inputPhoto,
          })),
        );
        return { ok: true };
      }

      case "join_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const inviteOrUsername = String(body.invite_link ?? body.username ?? "");
        if (!inviteOrUsername) return { ok: false, error: "invite_link or username is required" };

        if (inviteOrUsername.startsWith("https://t.me/+") || inviteOrUsername.startsWith("https://t.me/joinchat/")) {
          // Extract the hash from the invite link
          const hash = inviteOrUsername.split("/").pop() ?? "";
          const cleanHash = hash.startsWith("+") ? hash.slice(1) : hash;
          await withRetry(() =>
            client!.invoke(new Api.messages.ImportChatInvite({ hash: cleanHash })),
          );
        } else {
          const username = inviteOrUsername.startsWith("@") ? inviteOrUsername.slice(1) : inviteOrUsername;
          await withRetry(() =>
            client!.invoke(new Api.channels.JoinChannel({
              channel: username as unknown as import("telegram").Api.TypeInputChannel,
            })),
          );
        }
        return { ok: true };
      }

      case "leave_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        await withRetry(() =>
          client!.invoke(new Api.channels.LeaveChannel({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
          })),
        );
        return { ok: true };
      }

      case "create_group": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const title = String(body.title ?? "");
        if (!title) return { ok: false, error: "title is required" };
        const rawUserIds = body.user_ids;
        if (!Array.isArray(rawUserIds) || rawUserIds.length === 0)
          return { ok: false, error: "user_ids must be a non-empty array" };

        const userIds = (rawUserIds as unknown[]).map(Number);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() =>
          client!.invoke(new Api.messages.CreateChat({
            title,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            users: userIds as any,
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        const newChatId = result?.chats?.[0]?.id ? Number(result.chats[0].id) : null;
        return { ok: true, chat_id: newChatId };
      }

      case "create_supergroup": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const title = String(body.title ?? "");
        if (!title) return { ok: false, error: "title is required" };
        const about = String(body.about ?? body.description ?? "");

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() =>
          client!.invoke(new Api.channels.CreateChannel({
            title,
            about,
            megagroup: true,
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        const newChanId = result?.chats?.[0]?.id ? Number(result.chats[0].id) : null;
        return { ok: true, chat_id: newChanId };
      }

      case "invite_to_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const rawUserIds = body.user_ids;
        if (!Array.isArray(rawUserIds) || rawUserIds.length === 0)
          return { ok: false, error: "user_ids must be a non-empty array" };

        const userIds = (rawUserIds as unknown[]).map(Number);
        await withRetry(() =>
          client!.invoke(new Api.channels.InviteToChannel({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            users: userIds as any,
          })),
        );
        return { ok: true, invited: userIds.length };
      }

      case "delete_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = await client.getEntity(peer as any) as any;
        const isChannel = entity.className === "Channel";

        if (isChannel) {
          await withRetry(() =>
            client!.invoke(new Api.channels.DeleteChannel({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: peer as any,
            })),
          );
        } else {
          await withRetry(() =>
            client!.invoke(new Api.messages.DeleteChat({
              chatId: BigInt(peer) as unknown as import("big-integer").BigInteger,
            })),
          );
        }
        return { ok: true };
      }

      // ── Member management ──────────────────────────────────────────────────

      case "kick_member": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };
        const untilDate = typeof body.until_date === "number" ? body.until_date : 0;

        await withRetry(() =>
          client!.invoke(new Api.channels.EditBanned({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            participant: userId as any,
            bannedRights: new Api.ChatBannedRights({
              viewMessages: true,
              sendMessages: true,
              sendMedia: true,
              sendStickers: true,
              sendGifs: true,
              sendGames: true,
              sendInline: true,
              sendPolls: true,
              changeInfo: true,
              inviteUsers: true,
              pinMessages: true,
              untilDate,
            }),
          })),
        );
        return { ok: true };
      }

      case "unban_member": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.channels.EditBanned({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            participant: userId as any,
            bannedRights: new Api.ChatBannedRights({
              viewMessages: false,
              sendMessages: false,
              sendMedia: false,
              sendStickers: false,
              sendGifs: false,
              sendGames: false,
              sendInline: false,
              sendPolls: false,
              changeInfo: false,
              inviteUsers: false,
              pinMessages: false,
              untilDate: 0,
            }),
          })),
        );
        return { ok: true };
      }

      case "restrict_member": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        // Each restriction flag defaults to false (not restricted) unless explicitly set
        const noMessages = body.no_messages === true;
        const noMedia = body.no_media === true;
        const noStickers = body.no_stickers === true;
        const noGifs = body.no_gifs === true;
        const noGames = body.no_games === true;
        const noInline = body.no_inline === true;
        const noPolls = body.no_polls === true;
        const noChangeInfo = body.no_change_info === true;
        const noInviteUsers = body.no_invite_users === true;
        const noPinMessages = body.no_pin_messages === true;
        const untilDate = typeof body.until_date === "number" ? body.until_date : 0;

        await withRetry(() =>
          client!.invoke(new Api.channels.EditBanned({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            participant: userId as any,
            bannedRights: new Api.ChatBannedRights({
              viewMessages: false,
              sendMessages: noMessages,
              sendMedia: noMedia,
              sendStickers: noStickers,
              sendGifs: noGifs,
              sendGames: noGames,
              sendInline: noInline,
              sendPolls: noPolls,
              changeInfo: noChangeInfo,
              inviteUsers: noInviteUsers,
              pinMessages: noPinMessages,
              untilDate,
            }),
          })),
        );
        return { ok: true };
      }

      case "promote_admin": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };
        const rank = body.title ? String(body.title) : undefined;

        await withRetry(() =>
          client!.invoke(new Api.channels.EditAdmin({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userId: userId as any,
            adminRights: new Api.ChatAdminRights({
              changeInfo: true,
              postMessages: true,
              editMessages: true,
              deleteMessages: true,
              banUsers: true,
              inviteUsers: true,
              pinMessages: true,
              addAdmins: body.can_add_admins === true,
              anonymous: body.anonymous === true,
              manageCall: true,
              other: true,
            }),
            rank: rank ?? "",
          })),
        );
        return { ok: true };
      }

      case "demote_admin": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.channels.EditAdmin({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userId: userId as any,
            adminRights: new Api.ChatAdminRights({
              changeInfo: false,
              postMessages: false,
              editMessages: false,
              deleteMessages: false,
              banUsers: false,
              inviteUsers: false,
              pinMessages: false,
              addAdmins: false,
              anonymous: false,
              manageCall: false,
              other: false,
            }),
            rank: "",
          })),
        );
        return { ok: true };
      }

      case "set_member_tag": {
        // Gives a visible tag/title without actual admin rights (member tags feature).
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };
        const tag = String(body.tag ?? body.title ?? "");

        await withRetry(() =>
          client!.invoke(new Api.channels.EditAdmin({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userId: userId as any,
            adminRights: new Api.ChatAdminRights({
              other: false,
              changeInfo: false,
              postMessages: false,
              editMessages: false,
              deleteMessages: false,
              banUsers: false,
              inviteUsers: false,
              pinMessages: false,
              addAdmins: false,
              anonymous: false,
              manageCall: false,
            }),
            rank: tag,
          })),
        );
        return { ok: true };
      }

      case "toggle_slow_mode": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        // Valid values: 0 (off), 10, 30, 60, 300, 900, 3600
        const validSeconds = [0, 10, 30, 60, 300, 900, 3600];
        const seconds = Number(body.seconds ?? 0);
        if (!validSeconds.includes(seconds))
          return { ok: false, error: `seconds must be one of: ${validSeconds.join(", ")}` };

        await withRetry(() =>
          client!.invoke(new Api.channels.ToggleSlowMode({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            seconds,
          })),
        );
        return { ok: true, slow_mode_seconds: seconds };
      }

      case "get_admin_log": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const limit = Math.min(100, Number(body.limit ?? 20));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.channels.GetAdminLog({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
          q: body.query ? String(body.query) : "",
          limit,
          maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
          minId: BigInt(0) as unknown as import("big-integer").BigInteger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const events = (result.events ?? []) as Array<{
          id: unknown;
          date: number;
          userId: unknown;
          action: { className: string };
        }>;
        if (events.length === 0) return { ok: true, text: "No admin log events found." };

        const lines = events.map((e) =>
          `[${new Date(e.date * 1000).toISOString()}] user:${e.userId} — ${e.action?.className}`,
        );
        return { ok: true, text: lines.join("\n"), count: events.length };
      }

      // ── History / search (userbot-native, always available) ───────────────

      case "read_history":
        return {
          ok: true,
          text: await userbotHistory({
            chatId,
            limit: Math.min(100, Number(body.limit ?? 30)),
            offsetId: body.offset_id as number | undefined,
            before: body.before as string | undefined,
          }),
        };

      case "search_history":
        return {
          ok: true,
          text: await userbotSearch({
            chatId,
            query: String(body.query ?? ""),
            limit: Math.min(100, Number(body.limit ?? 20)),
          }),
        };

      case "get_user_messages":
        return {
          ok: true,
          text: await userbotSearch({
            chatId,
            query: String(body.user_name ?? ""),
            limit: Math.min(50, Number(body.limit ?? 20)),
          }),
        };

      case "list_known_users":
        return {
          ok: true,
          text: await userbotParticipantDetails({ chatId, limit: Number(body.limit ?? 50) }),
        };

      case "get_member_info":
        return {
          ok: true,
          text: await userbotGetUserInfo({ chatId, userId: Number(body.user_id) }),
        };

      case "get_message_by_id":
        return {
          ok: true,
          text: await userbotGetMessage({ chatId, messageId: Number(body.message_id) }),
        };

      case "get_pinned_messages":
        return { ok: true, text: await userbotPinnedMessages({ chatId }) };

      case "online_count":
        return { ok: true, text: await userbotOnlineCount({ chatId }) };

      case "download_media":
        return {
          ok: true,
          text: await downloadMessageMedia({ chatId, messageId: Number(body.message_id) }),
        };

      case "mark_as_read": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const maxId = typeof body.max_id === "number" ? body.max_id : 0;
        await withRetry(() =>
          client!.invoke(new Api.messages.ReadHistory({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            maxId,
          })),
        );
        return { ok: true };
      }

      case "search_global": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const query = String(body.query ?? "");
        if (!query) return { ok: false, error: "query is required" };
        const limit = Math.min(100, Number(body.limit ?? 20));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.messages.SearchGlobal({
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const messages = (result.messages ?? []) as Array<{
          id: number;
          date: number;
          message?: string;
          peerId?: { channelId?: unknown; chatId?: unknown; userId?: unknown };
        }>;
        if (messages.length === 0) return { ok: true, text: `No global results for "${query}".` };

        const lines = messages.map((m) => {
          const date = new Date(m.date * 1000).toISOString();
          const chatRef = m.peerId?.channelId ?? m.peerId?.chatId ?? m.peerId?.userId ?? "?";
          return `[msg:${m.id} chat:${chatRef} ${date}] ${m.message?.slice(0, 120) ?? "(media)"}`;
        });
        return { ok: true, text: lines.join("\n"), count: messages.length };
      }

      case "translate_text": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const text = String(body.text ?? "");
        const toLang = String(body.to_lang ?? "en");
        if (!text) return { ok: false, error: "text is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.messages.TranslateText({
          toLang,
          text: [new Api.TextWithEntities({ text, entities: [] })],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const translated = (result.result?.[0]?.text ?? result.text ?? "") as string;
        return { ok: true, translated, original: text, to_lang: toLang };
      }

      case "transcribe_audio": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.messages.TranscribeAudio({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: peer as any,
          msgId: Number(body.message_id),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        // result.text may be empty if still being processed (pending=true)
        return {
          ok: true,
          text: result.text ?? "",
          pending: result.pending ?? false,
          transcription_id: result.transcriptionId ? String(result.transcriptionId) : undefined,
        };
      }

      case "get_message_reactions": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.messages.GetMessagesReactions({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: peer as any,
          id: [msgId],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const updates = (result.updates ?? []) as Array<{
          className: string;
          reactions?: { results?: Array<{ reaction?: { emoticon?: string }; count: number; chosen?: boolean }> };
        }>;

        const reactionData = updates
          .filter((u) => u.className === "UpdateMessageReactions")
          .flatMap((u) => u.reactions?.results ?? [])
          .map((r) => ({
            emoji: r.reaction?.emoticon ?? "?",
            count: r.count,
            chosen: r.chosen ?? false,
          }));

        return { ok: true, reactions: reactionData, message_id: msgId };
      }

      case "get_dialogs": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const limit = Math.min(100, Number(body.limit ?? 20));
        const dialogs = await client.getDialogs({ limit });

        const formatted = dialogs.map((d) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = d.entity as any;
          const title = e?.title ?? e?.firstName ?? "(unnamed)";
          const username = e?.username ? ` @${e.username}` : "";
          const id = e?.id ? Number(e.id) : "?";
          const unread = (d as unknown as { unreadCount?: number }).unreadCount ?? 0;
          return `[chat:${id}]${username} ${title} — ${unread} unread`;
        });
        return { ok: true, text: formatted.join("\n"), count: dialogs.length };
      }

      case "get_common_chats": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.messages.GetCommonChats({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
          limit: Math.min(100, Number(body.limit ?? 20)),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const chats = (result.chats ?? []) as Array<{ id: unknown; title?: string; username?: string }>;
        const formatted = chats.map((c) =>
          `[chat:${Number(c.id)}] ${c.title ?? "(no title)"}${c.username ? ` @${c.username}` : ""}`,
        );
        return { ok: true, text: formatted.join("\n") || "No common chats.", count: chats.length };
      }

      // ── Contacts & account ─────────────────────────────────────────────────

      case "get_contacts": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.contacts.GetContacts({
          hash: BigInt(0) as unknown as import("big-integer").BigInteger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const users = (result.users ?? []) as Array<{
          id: unknown;
          firstName?: string;
          lastName?: string;
          username?: string;
          phone?: string;
        }>;
        if (users.length === 0) return { ok: true, text: "No contacts.", count: 0 };

        const formatted = users.map((u) => {
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
          const username = u.username ? ` @${u.username}` : "";
          const phone = u.phone ? ` +${u.phone}` : "";
          return `[id:${Number(u.id)}]${username} ${name}${phone}`;
        });
        return { ok: true, text: formatted.join("\n"), count: users.length };
      }

      case "add_contact": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const phone = String(body.phone_number ?? "");
        const firstName = String(body.first_name ?? "");
        const lastName = String(body.last_name ?? "");
        if (!phone || !firstName) return { ok: false, error: "phone_number and first_name are required" };

        await withRetry(() =>
          client!.invoke(new Api.contacts.ImportContacts({
            contacts: [
              new Api.InputPhoneContact({
                clientId: BigInt(Date.now()) as unknown as import("big-integer").BigInteger,
                phone,
                firstName,
                lastName,
              }),
            ],
          })),
        );
        return { ok: true };
      }

      case "delete_contact": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.contacts.DeleteContacts({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            id: [userId as any],
          })),
        );
        return { ok: true };
      }

      case "block_user": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.contacts.Block({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            id: userId as any,
          })),
        );
        return { ok: true };
      }

      case "unblock_user": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.contacts.Unblock({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            id: userId as any,
          })),
        );
        return { ok: true };
      }

      case "get_blocked_users": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const limit = Math.min(100, Number(body.limit ?? 20));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.contacts.GetBlocked({
          offset: 0,
          limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const users = (result.users ?? []) as Array<{
          id: unknown;
          firstName?: string;
          lastName?: string;
          username?: string;
        }>;
        if (users.length === 0) return { ok: true, text: "No blocked users.", count: 0 };

        const formatted = users.map((u) => {
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
          const username = u.username ? ` @${u.username}` : "";
          return `[id:${Number(u.id)}]${username} ${name}`;
        });
        return { ok: true, text: formatted.join("\n"), count: users.length };
      }

      // ── Stories ────────────────────────────────────────────────────────────

      case "post_story": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const filePath = String(body.file_path ?? "");
        if (!filePath) return { ok: false, error: "file_path is required" };
        const caption = body.caption ? String(body.caption) : undefined;
        const periodSeconds = typeof body.period_seconds === "number" ? body.period_seconds : 86400;

        // Determine if video or photo based on extension
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const storyFileSize = statSync(filePath).size;
        const uploaded = await withRetry(() =>
          client!.uploadFile({ file: new CustomFile(basename(filePath), storyFileSize, filePath), workers: 4 }),
        );
        const isVideo = ["mp4", "mov", "avi", "mkv", "webm"].includes(ext);

        const media = isVideo
          ? new Api.InputMediaUploadedDocument({
              file: uploaded,
              mimeType: "video/mp4",
              attributes: [new Api.DocumentAttributeVideo({ duration: 0, w: 0, h: 0 })],
              nosoundVideo: false,
            })
          : new Api.InputMediaUploadedPhoto({ file: uploaded });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() =>
          client!.invoke(new Api.stories.SendStory({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: new Api.InputPeerSelf() as any,
            media,
            caption: caption ?? "",
            period: periodSeconds,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            randomId: BigInt(Date.now()) as any,
            // Required: privacy rules — allow all contacts by default
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            privacyRules: [new Api.InputPrivacyValueAllowAll() as any],
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        const storyId = result?.updates?.find?.((u: { className: string }) => u.className === "UpdateStory")?.story?.id ?? null;
        return { ok: true, story_id: storyId };
      }

      case "delete_story": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const storyId = Number(body.story_id);
        if (!storyId) return { ok: false, error: "story_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.stories.DeleteStories({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: new Api.InputPeerSelf() as any,
            id: [storyId],
          })),
        );
        return { ok: true };
      }

      case "get_stories": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        // Defaults to own stories; pass user_id for another user's stories
        const targetPeer = body.user_id
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (Number(body.user_id) as any)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : (new Api.InputPeerSelf() as any);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.stories.GetPeerStories({
          peer: targetPeer,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const stories = (result.stories?.stories ?? []) as Array<{
          id: number;
          date: number;
          caption?: string;
          media?: { className: string };
        }>;
        if (stories.length === 0) return { ok: true, text: "No stories.", count: 0 };

        const formatted = stories.map((s) => {
          const date = new Date(s.date * 1000).toISOString();
          return `[story:${s.id} ${date}] ${s.caption || "(no caption)"} [${s.media?.className ?? "media"}]`;
        });
        return { ok: true, text: formatted.join("\n"), count: stories.length };
      }

      // ── Sticker set management (user accounts can create sticker packs) ────

      case "get_sticker_pack": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const shortName = String(body.short_name ?? body.pack_name ?? "");
        if (!shortName) return { ok: false, error: "short_name is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.messages.GetStickerSet({
          stickerset: new Api.InputStickerSetShortName({ shortName }),
          hash: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const set = result.set;
        const stickers = (result.documents ?? []) as Array<{ id: unknown; attributes?: Array<{ className: string; alt?: string }> }>;
        const lines = stickers.map((doc) => {
          const emoji = doc.attributes?.find((a) => a.className === "DocumentAttributeSticker")?.alt ?? "?";
          return `[doc:${doc.id}] ${emoji}`;
        });

        return {
          ok: true,
          title: set?.title,
          short_name: set?.shortName,
          count: stickers.length,
          text: lines.join("\n"),
        };
      }

      case "create_sticker_set": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const title = String(body.title ?? "");
        const shortName = String(body.short_name ?? "");
        const filePath = String(body.file_path ?? "");
        const emoji = String(body.emoji ?? "🙂");
        if (!title || !shortName || !filePath)
          return { ok: false, error: "title, short_name, and file_path are required" };

        // Upload sticker file, then wrap as InputDocument via UploadMedia
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const mimeType = ext === "tgs" ? "application/x-tgsticker"
          : ext === "webm" ? "video/webm"
          : "image/webp";

        const stickerFileSize = statSync(filePath).size;
        const uploaded = await withRetry(() =>
          client!.uploadFile({ file: new CustomFile(basename(filePath), stickerFileSize, filePath), workers: 1 }),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uploadedMedia = await withRetry(() =>
          client!.invoke(new Api.messages.UploadMedia({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: new Api.InputPeerSelf() as any,
            media: new Api.InputMediaUploadedDocument({
              file: uploaded,
              mimeType,
              attributes: [
                new Api.DocumentAttributeFilename({ fileName: basename(filePath) }),
                new Api.DocumentAttributeSticker({ alt: emoji, stickerset: new Api.InputStickerSetEmpty() }),
              ],
            }),
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        const doc = uploadedMedia.document;
        if (!doc) return { ok: false, error: "Failed to upload sticker media" };

        await withRetry(() =>
          client!.invoke(new Api.stickers.CreateStickerSet({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userId: new Api.InputUserSelf() as any,
            title,
            shortName,
            stickers: [
              new Api.InputStickerSetItem({
                document: new Api.InputDocument({
                  id: doc.id,
                  accessHash: doc.accessHash,
                  fileReference: doc.fileReference,
                }),
                emoji,
              }),
            ],
            emojis: mimeType !== "image/webp" || undefined,
          })),
        );
        return { ok: true, short_name: shortName };
      }

      case "add_sticker_to_set": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const shortName = String(body.short_name ?? "");
        const filePath = String(body.file_path ?? "");
        const emoji = String(body.emoji ?? "🙂");
        if (!shortName || !filePath)
          return { ok: false, error: "short_name and file_path are required" };

        const addExt = filePath.split(".").pop()?.toLowerCase() ?? "";
        const addMimeType = addExt === "tgs" ? "application/x-tgsticker"
          : addExt === "webm" ? "video/webm"
          : "image/webp";

        const addStickerSize = statSync(filePath).size;
        const uploaded = await withRetry(() =>
          client!.uploadFile({ file: new CustomFile(basename(filePath), addStickerSize, filePath), workers: 1 }),
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const uploadedMedia = await withRetry(() =>
          client!.invoke(new Api.messages.UploadMedia({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: new Api.InputPeerSelf() as any,
            media: new Api.InputMediaUploadedDocument({
              file: uploaded,
              mimeType: addMimeType,
              attributes: [
                new Api.DocumentAttributeFilename({ fileName: basename(filePath) }),
                new Api.DocumentAttributeSticker({ alt: emoji, stickerset: new Api.InputStickerSetEmpty() }),
              ],
            }),
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        const doc = uploadedMedia.document;
        if (!doc) return { ok: false, error: "Failed to upload sticker media" };

        await withRetry(() =>
          client!.invoke(new Api.stickers.AddStickerToSet({
            stickerset: new Api.InputStickerSetShortName({ shortName }),
            sticker: new Api.InputStickerSetItem({
              document: new Api.InputDocument({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
              }),
              emoji,
            }),
          })),
        );
        return { ok: true };
      }

      case "remove_sticker": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        // Requires a document ID for the sticker (get from get_sticker_pack)
        const docId = body.document_id ? String(body.document_id) : "";
        const accessHash = body.access_hash ? String(body.access_hash) : "0";
        const fileRef = body.file_reference
          ? Buffer.from(String(body.file_reference), "base64")
          : Buffer.alloc(0);
        if (!docId) return { ok: false, error: "document_id is required (from get_sticker_pack)" };

        await withRetry(() =>
          client!.invoke(new Api.stickers.RemoveStickerFromSet({
            sticker: new Api.InputDocument({
              id: BigInt(docId) as unknown as import("big-integer").BigInteger,
              accessHash: BigInt(accessHash) as unknown as import("big-integer").BigInteger,
              fileReference: fileRef,
            }),
          })),
        );
        return { ok: true };
      }

      // Legacy bot-only sticker actions (kept for compatibility)
      case "save_sticker_pack":
      case "download_sticker":
      case "set_sticker_set_title":
      case "delete_sticker_set":
        return { ok: false, error: `"${action}" is not supported in userbot mode.` };

      case "stop_poll":
        return { ok: false, error: "stop_poll is not supported in userbot mode." };

      // ── Forum topics ────────────────────────────────────────────────────────

      case "create_forum_topic": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const title = String(body.title ?? "");
        if (!title) return { ok: false, error: "title is required" };
        const iconColor = typeof body.icon_color === "number" ? body.icon_color : undefined;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() =>
          client!.invoke(new Api.channels.CreateForumTopic({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            title,
            iconColor,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            randomId: BigInt(Date.now()) as any,
          })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any;

        const topicId = result?.updates?.find?.((u: { className: string }) => u.className === "UpdateNewChannelMessage")?.message?.id ?? null;
        return { ok: true, topic_id: topicId };
      }

      case "edit_forum_topic": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const topicId = Number(body.topic_id);
        if (!topicId) return { ok: false, error: "topic_id is required" };

        await withRetry(() =>
          client!.invoke(new Api.channels.EditForumTopic({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            topicId,
            title: body.title ? String(body.title) : undefined,
            closed: body.closed === true ? true : body.closed === false ? false : undefined,
          })),
        );
        return { ok: true };
      }

      // ── Cross-chat: send to any peer by username / phone / ID ───────────────

      case "send_to_chat": {
        // `to` can be: "@username", "+phone", or a numeric chat/user ID string
        const to = String(body.to ?? "").trim();
        if (!to) return { ok: false, error: "to is required (username, phone, or chat ID)" };

        // Resolve peer: numeric string → number, everything else → string for GramJS
        const targetPeer: number | string = /^-?\d+$/.test(to) ? Number(to) : to;

        const contentType = String(body.type ?? "text");
        const text = String(body.text ?? "");
        const filePath = body.file_path ? String(body.file_path) : undefined;
        const caption = body.caption ? String(body.caption) : undefined;

        if (contentType === "text" || !filePath) {
          if (!text) return { ok: false, error: "text is required for type=text" };
          const msgId = await withRetry(() => sendUserbotMessage(targetPeer, text));
          return { ok: true, message_id: msgId, to };
        }

        // File-based types: photo, video, voice, file
        const fileData = readFileSync(filePath);
        const fileName = basename(filePath);
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const uploaded = await withRetry(() =>
          client!.uploadFile({ file: new CustomFile(fileName, fileData.length, filePath), workers: 4 }),
        );
        const msgId = await withRetry(() =>
          sendUserbotFile(targetPeer, { filePath, caption }),
        );
        return { ok: true, message_id: msgId, to };
      }

      default:
        return null; // not a Telegram action — fall through to shared handlers
    }
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function replyParams(body: Record<string, unknown>): number | undefined {
  const replyTo = body.reply_to ?? body.reply_to_message_id;
  return typeof replyTo === "number" && replyTo > 0 ? replyTo : undefined;
}

/**
 * Extract the first message ID from a GramJS Updates result object.
 * Handles Updates, UpdatesCombined, and UpdateShort variants.
 */
function extractMessageId(result: unknown): number | undefined {
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
