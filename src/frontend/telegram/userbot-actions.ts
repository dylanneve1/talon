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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
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

// ── Keyword watch type ───────────────────────────────────────────────────────
type KeywordWatch = {
  keyword: string;
  chatId?: number; // restrict to specific chat (undefined = all chats)
  createdAt: string;
};

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

      // copy_message: forward without attribution; supports to_chat for cross-chat copy
      case "copy_message": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const srcMsgId = Number(body.message_id);
        const toChatRaw = body.to_chat ?? body.to_chat_id;
        if (toChatRaw) {
          const toPeer: number | string = /^-?\d+$/.test(String(toChatRaw)) ? Number(toChatRaw) : String(toChatRaw);
          // Forward with noforwards=false (copy — no attribution link in TDLib terms)
          await withRetry(() => client!.forwardMessages(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            toPeer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { messages: [srcMsgId], fromPeer: peer as any, noforwards: false, dropAuthor: true },
          ));
          return { ok: true, message_id: srcMsgId, to_chat: toChatRaw };
        }
        const sentId = await forwardUserbotMessage(peer, srcMsgId);
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

        const solutionText = isQuiz && correctOption !== undefined && body.explanation
          ? String(body.explanation)
          : undefined;

        const media = new Api.InputMediaPoll({
          poll,
          correctAnswers: isQuiz && correctOption !== undefined
            ? [Buffer.from([correctOption])]
            : undefined,
          // Only set solution/solutionEntities when there's actual solution text —
          // they share the same TL flag bit; setting one without the other causes INPUT_FETCH_ERROR
          solution: solutionText,
          solutionEntities: solutionText ? [] : undefined,
        });

        gateway.incrementMessages(chatId);
        const sendResult = await withRetry(() =>
          client!.invoke(new Api.messages.SendMedia({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            media,
            message: "",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            randomId: BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000)) as any,
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
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        try {
          // Use channels.GetParticipant so we get the rank field
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await client.invoke(new Api.channels.GetParticipant({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            channel: peer as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            participant: userId as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          })) as any;
          const p = result.participant;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const u = result.users?.[0] as any;
          const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)") : String(userId);
          const username = u?.username ? `@${u.username}` : "";
          const role = p.className === "ChannelParticipantCreator" ? "owner"
            : p.className === "ChannelParticipantAdmin" ? "admin"
            : "member";
          const tag = p.rank ? `\nTag: ${p.rank}` : "";
          const joined = p.date ? `\nJoined: ${new Date(p.date * 1000).toISOString()}` : "";
          return { ok: true, text: `${name} ${username}\nID: ${userId}\nRole: ${role}${tag}${joined}` };
        } catch {
          // Fallback for basic groups
          const text = await userbotGetUserInfo({ chatId, userId }).catch((e) => String(e));
          return { ok: true, text };
        }
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
        const isBasicGroupPhoto = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
        if (isBasicGroupPhoto) {
          await withRetry(() =>
            client!.invoke(new Api.messages.EditChatPhoto({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chatId: Math.abs(peer) as any,
              photo: inputPhoto,
            })),
          );
        } else {
          await withRetry(() =>
            client!.invoke(new Api.channels.EditPhoto({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: peer as any,
              photo: inputPhoto,
            })),
          );
        }
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

        const isBasicGroupLeave = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
        if (isBasicGroupLeave) {
          const self = await client.getMe();
          await withRetry(() =>
            client!.invoke(new Api.messages.DeleteChatUser({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chatId: Math.abs(peer) as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              userId: self as any,
            })),
          );
        } else {
          await withRetry(() =>
            client!.invoke(new Api.channels.LeaveChannel({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: peer as any,
            })),
          );
        }
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
        const isBasicGroupInvite = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
        if (isBasicGroupInvite) {
          // Basic groups only support adding one user at a time
          for (const uid of userIds) {
            await withRetry(() =>
              client!.invoke(new Api.messages.AddChatUser({
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                chatId: Math.abs(peer) as any,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                userId: uid as any,
                fwdLimit: 10,
              })),
            );
          }
        } else {
          await withRetry(() =>
            client!.invoke(new Api.channels.InviteToChannel({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: peer as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              users: userIds as any,
            })),
          );
        }
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

        // Supergroup/channel IDs have abs value > 1e12; basic groups are smaller
        const isBasicGroup = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
        if (isBasicGroup) {
          // Basic groups: simple admin flag, no granular rights
          await withRetry(() =>
            client!.invoke(new Api.messages.EditChatAdmin({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chatId: Math.abs(peer) as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              userId: userId as any,
              isAdmin: true,
            })),
          );
        } else {
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
        }
        return { ok: true };
      }

      case "demote_admin": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };

        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id is required" };

        const isBasicGroupDemote = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
        if (isBasicGroupDemote) {
          await withRetry(() =>
            client!.invoke(new Api.messages.EditChatAdmin({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chatId: Math.abs(peer) as any,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              userId: userId as any,
              isAdmin: false,
            })),
          );
        } else {
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
        }
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

      case "get_user_messages": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const targetUserId = body.user_id ? Number(body.user_id) : null;
        if (!targetUserId) return { ok: false, error: "user_id is required" };
        const msgLimit = Math.min(Number(body.limit ?? 20), 100);
        // Use messages.Search with fromId to filter by sender
        const entity = await client.getEntity(targetUserId).catch(() => null);
        if (!entity) return { ok: false, error: `Could not resolve user ${targetUserId}` };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const searchResult = await withRetry(() => client!.invoke(new Api.messages.Search({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: peer as any,
          q: "",
          filter: new Api.InputMessagesFilterEmpty(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fromId: entity as any,
          minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0,
          limit: msgLimit,
          maxId: 0, minId: 0,
          hash: BigInt(0) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msgs = (searchResult.messages ?? []) as any[];
        const lines = msgs.map((m: any) => {
          const date = new Date((m.date ?? 0) * 1000).toISOString();
          return `[${date}] [msg:${m.id}] ${m.message || "(media)"}`;
        });
        return { ok: true, user_id: targetUserId, count: lines.length, messages: lines.join("\n") };
      }

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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatted = dialogs.map((d: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const e = d.entity as any;
          const title = e?.title ?? e?.firstName ?? "(unnamed)";
          const lastName = e?.lastName ? ` ${e.lastName}` : "";
          const username = e?.username ? ` @${e.username}` : "";
          const id = e?.id ? Number(e.id) : "?";
          const unread = d.unreadCount ?? 0;
          const mentions = d.unreadMentionsCount ?? 0;
          const lastMsg = d.message?.message ? ` | "${String(d.message.message).slice(0, 60)}"` : "";
          const lastDate = d.message?.date ? ` [${new Date(d.message.date * 1000).toISOString().slice(0, 10)}]` : "";
          const type = e?.className === "User" ? (e.bot ? "bot" : "user")
            : e?.className === "Channel" ? (e.megagroup ? "supergroup" : "channel")
            : e?.className === "Chat" ? "group" : "?";
          return `[chat:${id} type:${type}]${username} ${title}${lastName}${lastDate} — ${unread} unread${mentions > 0 ? ` (${mentions} mentions)` : ""}${lastMsg}`;
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
        const offset = Number(body.offset ?? 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await client.invoke(new Api.contacts.GetBlocked({
          offset,
          limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;

        const users = (result.users ?? []) as Array<{
          id: unknown;
          firstName?: string;
          lastName?: string;
          username?: string;
        }>;
        const totalCount = Number(result.count ?? users.length);
        if (users.length === 0) return { ok: true, text: "No blocked users.", count: 0, total: 0 };

        const formatted = users.map((u) => {
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
          const username = u.username ? ` @${u.username}` : "";
          return `[id:${Number(u.id)}]${username} ${name}`;
        });
        return { ok: true, text: formatted.join("\n"), count: users.length, total: totalCount, offset, has_more: offset + users.length < totalCount };
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
        const msgId = await withRetry(() =>
          sendUserbotFile(targetPeer, { filePath, caption }),
        );
        return { ok: true, message_id: msgId, to };
      }

      // ── Invite links ────────────────────────────────────────────────────────

      case "get_invite_link": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.ExportChatInvite({ peer: p as any }))) as any;
        return { ok: true, link: result.link };
      }

      case "create_invite_link": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const expireDate = body.expire_date ? Number(body.expire_date) : undefined;
        const usageLimit = body.usage_limit ? Number(body.usage_limit) : undefined;
        const title = body.title ? String(body.title) : undefined;
        const requestNeeded = body.request_needed === true;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.ExportChatInvite({ peer: p as any, expireDate, usageLimit, title, requestNeeded }))) as any;
        return { ok: true, link: result.link, title: result.title, expire_date: result.expireDate, usage_limit: result.usageLimit };
      }

      case "revoke_invite_link": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const link = String(body.link ?? "");
        if (!link) return { ok: false, error: "link is required" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.EditExportedChatInvite({ peer: p as any, link, revoked: true }))) as any;
        return { ok: true, revoked_link: result.invite?.link ?? link };
      }

      case "get_invite_links": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // Use InputUserSelf so GramJS can properly serialize the adminId field
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetExportedChatInvites({ peer: p as any, adminId: new Api.InputUserSelf(), limit: 20 }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lines = (result.invites ?? []).map((inv: any) => {
          const used = inv.usage ? ` (${inv.usage} uses)` : "";
          const limit = inv.usageLimit ? `/${inv.usageLimit}` : "";
          const exp = inv.expireDate ? ` expires ${new Date(inv.expireDate * 1000).toISOString()}` : "";
          const revoked = inv.revoked ? " [revoked]" : "";
          return `${inv.link}${used}${limit}${exp}${revoked}`;
        });
        return { ok: true, text: lines.length ? lines.join("\n") : "No invite links found.", count: lines.length };
      }

      // ── Cross-chat read ──────────────────────────────────────────────────────

      case "read_any_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const target = String(body.target ?? "");
        if (!target) return { ok: false, error: "target is required (@username, +phone, or numeric ID)" };
        const targetPeer: number | string = /^-?\d+$/.test(target) ? Number(target) : target;
        const limit = Math.min(100, Number(body.limit ?? 20));
        const offsetDate = body.before ? Math.floor(new Date(String(body.before)).getTime() / 1000) : undefined;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msgs = await client.getMessages(targetPeer as any, { limit, offsetDate });
        if (!msgs.length) return { ok: true, text: "No messages found.", count: 0 };
        const lines = msgs.reverse().map((m) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sender = (m as any).senderId ? `[id:${Number((m as any).senderId)}]` : "[unknown]";
          const date = new Date((m.date ?? 0) * 1000).toISOString();
          const text = m.text || m.message || "(media)";
          return `[${date}] ${sender}: ${text}`;
        });
        return { ok: true, text: lines.join("\n"), count: msgs.length };
      }

      // ── Cross-chat forward ───────────────────────────────────────────────────

      case "forward_to": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const to = String(body.to ?? "").trim();
        if (!to) return { ok: false, error: "to is required (@username, numeric ID, etc.)" };
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };
        const targetPeer: number | string = /^-?\d+$/.test(to) ? Number(to) : to;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withRetry(() => client!.forwardMessages(targetPeer as any, { messages: [msgId], fromPeer: peer as any }));
        return { ok: true, to };
      }

      // ── Poll voting ─────────────────────────────────────────────────────────

      case "vote_poll": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };
        const optionIndex = Number(body.option_index ?? 0);

        // Strategy: try to get option bytes from poll results first (works even when
        // the poll media comes back as MessageMediaUnsupported due to layer mismatch)
        let optionBytes: Buffer | null = null;
        let votedFor = String(optionIndex);

        // First attempt: fetch from poll results (PollAnswerVoters has the option bytes)
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pollResultsData = await withRetry(() => client!.invoke(new Api.messages.GetPollResults({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: peer as any,
            msgId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }))) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const answerVoters = pollResultsData?.results?.results as any[] | undefined;
          if (answerVoters && answerVoters[optionIndex]) {
            optionBytes = Buffer.from(answerVoters[optionIndex].option);
          }
        } catch { /* fall through to media-based approach */ }

        // Second attempt: deserialize poll media (works when no MessageMediaUnsupported issue)
        if (!optionBytes) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const msgs = await client.getMessages(peer as any, { ids: [msgId] });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pollMedia = (msgs[0] as any)?.media;
          if (pollMedia?.className === "MessageMediaPoll") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const answers = pollMedia.poll?.answers as any[] ?? [];
            if (optionIndex < 0 || optionIndex >= answers.length)
              return { ok: false, error: `Invalid option_index. Poll has ${answers.length} options (0-${answers.length - 1})` };
            const answer = answers[optionIndex];
            optionBytes = Buffer.from(answer.option);
            votedFor = typeof answer.text === "string" ? answer.text : (answer.text?.text ?? String(optionIndex));
          } else if (pollMedia?.className === "MessageMediaUnsupported") {
            // Last resort: try common single-byte option values (polls created via GramJS use Buffer.from([index]))
            optionBytes = Buffer.from([optionIndex]);
          }
        }

        if (!optionBytes) return { ok: false, error: "Could not find poll or its options at that message ID" };

        await withRetry(() => client!.invoke(new Api.messages.SendVote({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: peer as any,
          msgId,
          options: [optionBytes!],
        })));
        return { ok: true, voted_for: votedFor, option_index: optionIndex };
      }

      // ── Dialog / chat organisation ──────────────────────────────────────────

      case "pin_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const pinned = body.pinned !== false;
        await withRetry(() => client!.invoke(new Api.messages.ToggleDialogPin({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: new Api.InputDialogPeer({ peer: p as any }) as any,
          pinned,
        })));
        return { ok: true, pinned };
      }

      case "archive_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const archive = body.archive !== false;
        await withRetry(() => client!.invoke(new Api.folders.EditPeerFolders({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          folderPeers: [new Api.InputFolderPeer({ peer: p as any, folderId: archive ? 1 : 0 }) as any],
        })));
        return { ok: true, archived: archive };
      }

      case "mute_chat": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const muted = body.muted !== false;
        const durationSeconds = body.duration_seconds ? Number(body.duration_seconds) : undefined;
        const muteUntil = muted
          ? (durationSeconds ? Math.floor(Date.now() / 1000) + durationSeconds : 2_147_483_647)
          : 0;
        await withRetry(() => client!.invoke(new Api.account.UpdateNotifySettings({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: new Api.InputNotifyPeer({ peer: p as any }) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          settings: new Api.InputPeerNotifySettings({ muteUntil }) as any,
        })));
        return { ok: true, muted, mute_until: muteUntil };
      }

      // ── Save to Saved Messages ───────────────────────────────────────────────

      case "save_to_saved": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const msgId = Number(body.message_id);
        const fromPeer = body.chat_id ? Number(body.chat_id) : peer;
        if (msgId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await withRetry(() => client!.forwardMessages(new Api.InputPeerSelf() as any, { messages: [msgId], fromPeer: fromPeer as any }));
        } else {
          const text = String(body.text ?? "");
          if (!text) return { ok: false, error: "Provide message_id or text" };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await withRetry(() => sendUserbotMessage(new Api.InputPeerSelf() as any, text));
        }
        return { ok: true };
      }

      // ── Message link ─────────────────────────────────────────────────────────

      case "get_message_link": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await withRetry(() => client!.invoke(new Api.channels.ExportMessageLink({ channel: p as any, id: msgId, grouped: false }))) as any;
          return { ok: true, link: result.link };
        } catch {
          return { ok: false, error: "Could not get message link — only works for channels/supergroups" };
        }
      }

      // ── Username check ────────────────────────────────────────────────────────

      case "check_username": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const username = String(body.username ?? "").replace(/^@/, "");
        if (!username) return { ok: false, error: "username is required" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const available = await withRetry(() => client!.invoke(new Api.account.CheckUsername({ username }))) as any;
        return { ok: true, username, available: !!available };
      }

      // ── Full user profile ─────────────────────────────────────────────────────

      case "get_full_user": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const target = String(body.target ?? body.user_id ?? "").trim();
        if (!target) return { ok: false, error: "target is required (@username, phone, or user ID)" };
        const targetPeer: number | string = /^-?\d+$/.test(target) ? Number(target) : target;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = await client.getEntity(targetPeer as any) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const full = await withRetry(() => client!.invoke(new Api.users.GetFullUser({ id: entity as any }))) as any;
        const u = full.users?.[0] ?? entity;
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
        const username = u.username ? `@${u.username}` : "none";
        const bio = full.fullUser?.about ?? "(no bio)";
        const phone = u.phone ? `+${u.phone}` : "hidden";
        const commonChatsCount = full.fullUser?.commonChatsCount ?? 0;
        const premium = u.premium ? " [Premium]" : "";
        const verified = u.verified ? " [Verified]" : "";
        const bot = u.bot ? " [Bot]" : "";
        return {
          ok: true,
          text: `${name}${premium}${verified}${bot}\nUsername: ${username}\nID: ${Number(u.id)}\nPhone: ${phone}\nBio: ${bio}\nCommon chats: ${commonChatsCount}`,
        };
      }

      // ── Bulk delete ───────────────────────────────────────────────────────────

      case "delete_messages_bulk": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const ids = Array.isArray(body.message_ids)
          ? (body.message_ids as unknown[]).map(Number).filter(Boolean)
          : [];
        if (!ids.length) return { ok: false, error: "message_ids array is required" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withRetry(() => client!.deleteMessages(peer as any, ids, { revoke: body.revoke !== false }));
        return { ok: true, deleted: ids.length };
      }

      // ── Privacy settings ──────────────────────────────────────────────────────

      case "get_privacy": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const keyName = String(body.key ?? "status_timestamp");
        const keyMap: Record<string, unknown> = {
          status_timestamp: new Api.InputPrivacyKeyStatusTimestamp(),
          chat_invite: new Api.InputPrivacyKeyChatInvite(),
          phone_number: new Api.InputPrivacyKeyPhoneNumber(),
          phone_call: new Api.InputPrivacyKeyPhoneCall(),
          phone_p2p: new Api.InputPrivacyKeyPhoneP2P(),
          forwards: new Api.InputPrivacyKeyForwards(),
          profile_photo: new Api.InputPrivacyKeyProfilePhoto(),
          about: new Api.InputPrivacyKeyAbout(),
        };
        const privKey = keyMap[keyName] ?? new Api.InputPrivacyKeyStatusTimestamp();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.account.GetPrivacy({ key: privKey as any }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rules = (result.rules ?? []).map((r: any) => r.className).join(", ");
        return { ok: true, key: keyName, rules };
      }

      case "set_privacy": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const keyName = String(body.key ?? "status_timestamp");
        const ruleName = String(body.rule ?? "allow_all");
        const keyMap: Record<string, unknown> = {
          status_timestamp: new Api.InputPrivacyKeyStatusTimestamp(),
          chat_invite: new Api.InputPrivacyKeyChatInvite(),
          phone_number: new Api.InputPrivacyKeyPhoneNumber(),
          phone_call: new Api.InputPrivacyKeyPhoneCall(),
          profile_photo: new Api.InputPrivacyKeyProfilePhoto(),
          forwards: new Api.InputPrivacyKeyForwards(),
          about: new Api.InputPrivacyKeyAbout(),
        };
        const ruleMap: Record<string, unknown> = {
          allow_all: new Api.InputPrivacyValueAllowAll(),
          allow_contacts: new Api.InputPrivacyValueAllowContacts(),
          allow_close_friends: new Api.InputPrivacyValueAllowCloseFriends(),
          disallow_all: new Api.InputPrivacyValueDisallowAll(),
          disallow_contacts: new Api.InputPrivacyValueDisallowContacts(),
        };
        const privKey = keyMap[keyName] ?? new Api.InputPrivacyKeyStatusTimestamp();
        const privRule = ruleMap[ruleName] ?? new Api.InputPrivacyValueAllowAll();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withRetry(() => client!.invoke(new Api.account.SetPrivacy({ key: privKey as any, rules: [privRule as any] })));
        return { ok: true, key: keyName, rule: ruleName };
      }

      // ── Notes ──────────────────────────────────────────────────────────────

      case "save_note": {
        const key = String(body.key ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
        if (!key) return { ok: false, error: "key is required" };
        const content = String(body.content ?? body.value ?? "");
        const tags: string[] = Array.isArray(body.tags) ? (body.tags as unknown[]).map(String) : [];
        const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
        mkdirSync(notesDir, { recursive: true });
        const note = { key, content, tags, updatedAt: new Date().toISOString() };
        writeFileSync(resolve(notesDir, `${key}.json`), JSON.stringify(note, null, 2));
        return { ok: true, key };
      }

      case "get_note": {
        const key = String(body.key ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
        if (!key) return { ok: false, error: "key is required" };
        const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
        try {
          const note = JSON.parse(readFileSync(resolve(notesDir, `${key}.json`), "utf8"));
          return { ok: true, ...note };
        } catch {
          return { ok: false, error: `Note "${key}" not found` };
        }
      }

      case "list_notes": {
        const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
        try {
          const files = readdirSync(notesDir).filter((f) => f.endsWith(".json"));
          const tag = body.tag ? String(body.tag) : null;
          const notes = files
            .map((f) => {
              try {
                const n = JSON.parse(readFileSync(resolve(notesDir, f), "utf8")) as { key: string; content?: string; tags?: string[]; updatedAt?: string };
                if (tag && !(n.tags ?? []).includes(tag)) return null;
                return { key: n.key, tags: n.tags ?? [], updatedAt: n.updatedAt, preview: String(n.content ?? "").slice(0, 120) };
              } catch { return null; }
            })
            .filter(Boolean);
          return { ok: true, count: notes.length, notes };
        } catch {
          return { ok: true, count: 0, notes: [] };
        }
      }

      case "delete_note": {
        const key = String(body.key ?? "").trim().replace(/[^a-zA-Z0-9_.-]/g, "_");
        if (!key) return { ok: false, error: "key is required" };
        const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
        try {
          unlinkSync(resolve(notesDir, `${key}.json`));
          return { ok: true };
        } catch {
          return { ok: false, error: `Note "${key}" not found` };
        }
      }

      case "search_notes": {
        const query = String(body.query ?? "").toLowerCase().trim();
        if (!query) return { ok: false, error: "query is required" };
        const notesDir = resolve(process.env.HOME ?? "/root", ".talon/workspace/notes");
        try {
          const files = readdirSync(notesDir).filter((f) => f.endsWith(".json"));
          const matches = files
            .map((f) => {
              try {
                const n = JSON.parse(readFileSync(resolve(notesDir, f), "utf8")) as { key: string; content?: string; tags?: string[]; updatedAt?: string };
                const haystack = `${n.key} ${n.content ?? ""} ${(n.tags ?? []).join(" ")}`.toLowerCase();
                if (!haystack.includes(query)) return null;
                return { key: n.key, tags: n.tags ?? [], updatedAt: n.updatedAt, preview: String(n.content ?? "").slice(0, 300) };
              } catch { return null; }
            })
            .filter(Boolean);
          return { ok: true, query, count: matches.length, notes: matches };
        } catch {
          return { ok: true, query, count: 0, notes: [] };
        }
      }

      // ── Online / activity awareness ─────────────────────────────────────────

      case "get_online_status": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const userId = body.user_id;
        if (!userId) return { ok: false, error: "user_id is required" };
        // Must resolve to InputUser (with accessHash) before invoking GetFullUser
        const resolvedUser = await client.getEntity(Number(userId)).catch(() => null);
        if (!resolvedUser) return { ok: false, error: `Could not resolve user ${userId}` };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.users.GetFullUser({ id: resolvedUser as any }))) as any;
        const user = result.users?.[0] as any;
        const status = user?.status;
        if (!status) return { ok: true, user_id: userId, status: "unknown" };
        const cn = status.className;
        if (cn === "UserStatusOnline") return { ok: true, status: "online", expires: new Date(status.expires * 1000).toISOString() };
        if (cn === "UserStatusOffline") return { ok: true, status: "offline", wasOnline: new Date(status.wasOnline * 1000).toISOString() };
        if (cn === "UserStatusRecently") return { ok: true, status: "recently_online" };
        if (cn === "UserStatusLastWeek") return { ok: true, status: "last_week" };
        if (cn === "UserStatusLastMonth") return { ok: true, status: "last_month" };
        return { ok: true, status: cn };
      }

      case "get_unread_counts": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const limit = Math.min(Number(body.limit ?? 100), 200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetDialogs({
          offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          limit, hash: BigInt(0) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatsMap = new Map<string, any>((result.chats ?? []).map((c: any) => [String(c.id), c]));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usersMap = new Map<string, any>((result.users ?? []).map((u: any) => [String(u.id), u]));
        const dialogs: Array<{ chatId: string; title: string; unread: number; mentions: number }> = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const d of (result.dialogs ?? []) as any[]) {
          const unread = Number(d.unreadCount ?? 0);
          if (unread === 0) continue;
          const p = d.peer as any;
          let chatId = "";
          let title = "Unknown";
          if (p?.className === "PeerUser") {
            chatId = String(p.userId);
            const u = usersMap.get(String(p.userId));
            title = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.username || chatId;
          } else if (p?.className === "PeerChat") {
            chatId = String(-Number(p.chatId));
            title = chatsMap.get(String(p.chatId))?.title || chatId;
          } else if (p?.className === "PeerChannel") {
            // Safely reconstruct the full channel ID (avoid BigInt precision loss)
            chatId = `-100${BigInt(p.channelId).toString()}`;
            title = chatsMap.get(String(p.channelId))?.title || chatId;
          }
          dialogs.push({ chatId, title, unread, mentions: Number(d.unreadMentionsCount ?? 0) });
        }
        dialogs.sort((a, b) => b.unread - a.unread);
        return { ok: true, total_unread: dialogs.reduce((s, d) => s + d.unread, 0), chats: dialogs };
      }

      // ── Drafts ──────────────────────────────────────────────────────────────

      case "get_draft": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const targetPeer = body.chat_id ? Number(body.chat_id) : peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetAllDrafts())) as any;
        // GetAllDrafts returns updates; find the draft for our target peer
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const update = (result?.updates ?? []).find((u: any) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p2 = u.peer as any;
          if (!p2) return false;
          if (p2.className === "PeerUser") return Number(p2.userId) === targetPeer;
          if (p2.className === "PeerChat") return -Number(p2.chatId) === targetPeer;
          if (p2.className === "PeerChannel") return String(`-100${BigInt(p2.channelId).toString()}`) === String(targetPeer);
          return false;
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const draft = update?.draft as any;
        if (!draft || draft.className === "DraftMessageEmpty") return { ok: true, draft: null };
        return { ok: true, draft: { text: draft.message, date: new Date((draft.date ?? 0) * 1000).toISOString() } };
      }

      case "set_draft": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const text = String(body.text ?? "");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withRetry(() => client!.invoke(new Api.messages.SaveDraft({ peer: p as any, message: text })));
        return { ok: true };
      }

      // ── Broadcast ───────────────────────────────────────────────────────────

      case "broadcast": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const text = String(body.text ?? "");
        if (!text) return { ok: false, error: "text is required" };
        const targets = Array.isArray(body.targets) ? (body.targets as unknown[]) : [];
        if (!targets.length) return { ok: false, error: "targets array is required (list of chat IDs or usernames)" };
        const results: Array<{ target: unknown; ok: boolean; error?: string }> = [];
        for (const target of targets) {
          try {
            // Resolve entity first to ensure peer has accessHash (required for users/channels)
            const resolvedTarget = await client.getEntity(
              typeof target === "number" || typeof target === "string" ? target : String(target)
            ).catch(() => target);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await withRetry(() => client!.sendMessage(resolvedTarget as any, { message: text }));
            results.push({ target, ok: true });
            await new Promise((r) => setTimeout(r, 700)); // anti-flood delay
          } catch (err) {
            results.push({ target, ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        }
        const sent = results.filter((r) => r.ok).length;
        return { ok: true, sent, failed: results.length - sent, results };
      }

      // ── Keyword watches ─────────────────────────────────────────────────────

      case "watch_keyword": {
        const keyword = String(body.keyword ?? "").trim();
        if (!keyword) return { ok: false, error: "keyword is required" };
        const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
        let watches: KeywordWatch[] = [];
        try { watches = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[]; } catch { /* new */ }
        const newChatId = body.chat_id ? Number(body.chat_id) : undefined;
        // Deduplicate: remove existing same keyword+chatId combo
        watches = watches.filter((w) => !(w.keyword.toLowerCase() === keyword.toLowerCase() && w.chatId === newChatId));
        watches.push({ keyword, chatId: newChatId, createdAt: new Date().toISOString() });
        mkdirSync(resolve(process.env.HOME ?? "/root", ".talon/workspace"), { recursive: true });
        writeFileSync(watchesPath, JSON.stringify(watches, null, 2));
        return { ok: true, keyword, chat_id: newChatId, total_watches: watches.length };
      }

      case "unwatch_keyword": {
        const keyword = String(body.keyword ?? "").trim();
        if (!keyword) return { ok: false, error: "keyword is required" };
        const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
        let watches: KeywordWatch[] = [];
        try { watches = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[]; } catch { return { ok: false, error: "No watches configured" }; }
        const before = watches.length;
        watches = watches.filter((w) => w.keyword.toLowerCase() !== keyword.toLowerCase());
        writeFileSync(watchesPath, JSON.stringify(watches, null, 2));
        return { ok: true, removed: before - watches.length, remaining: watches.length };
      }

      case "list_watches": {
        const watchesPath = resolve(process.env.HOME ?? "/root", ".talon/workspace/keyword-watches.json");
        try {
          const watches = JSON.parse(readFileSync(watchesPath, "utf8")) as KeywordWatch[];
          return { ok: true, count: watches.length, watches };
        } catch {
          return { ok: true, count: 0, watches: [] };
        }
      }

      // ── Get available reactions ──────────────────────────────────────────────

      case "get_reactions_available": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetAvailableReactions({
          hash: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const reactions = (result.reactions ?? []) as any[];
        const formatted = reactions.map((r) => ({
          emoji: r.reaction ?? "?",
          title: r.title ?? "",
          premium: r.premium ?? false,
        }));
        return { ok: true, count: formatted.length, reactions: formatted };
      }

      // ── Get read participants ────────────────────────────────────────────────

      case "get_read_participants": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await withRetry(() => client!.invoke(new Api.messages.GetMessageReadParticipants({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            peer: p as any,
            msgId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }))) as any;
          // Result is a list of ReadParticipantDate objects
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const readers = Array.isArray(result) ? result as any[] : [];
          return {
            ok: true,
            message_id: msgId,
            count: readers.length,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            readers: readers.map((r: any) => ({
              user_id: Number(r.userId ?? r),
              date: r.date ? new Date(r.date * 1000).toISOString() : null,
            })),
          };
        } catch (err) {
          return { ok: false, error: `Read participants not available: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      // ── Clear chat history ───────────────────────────────────────────────────

      case "clear_chat_history": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const revoke = body.revoke === true; // false = local only, true = both sides (DMs only)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.DeleteHistory({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          maxId: 0, // 0 = all messages
          revoke,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        return { ok: true, revoke, pts: result?.pts ?? 0 };
      }

      // ── Get profile photos ───────────────────────────────────────────────────

      case "get_profile_photos": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const userId = body.user_id ? Number(body.user_id) : null;
        const limit = Math.min(50, Number(body.limit ?? 10));
        const targetUser = userId
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? (userId as any)
          : new Api.InputUserSelf();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.photos.GetUserPhotos({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: targetUser as any,
          offset: 0,
          maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
          limit,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const photos = (result.photos ?? []) as any[];
        const formatted = photos.map((p_) => ({
          id: String(p_.id),
          date: p_.date ? new Date(p_.date * 1000).toISOString() : null,
        }));
        return { ok: true, count: formatted.length, photos: formatted };
      }

      // ── Connection status ─────────────────────────────────────────────────────

      case "get_connection_status": {
        const client = getClient();
        const connected = !!client;
        if (!client) return { ok: true, connected: false, authorized: false };
        try {
          const authorized = await client.isUserAuthorized();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const session = (client as any).session;
          const dcId = session?.dcId ?? null;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const me = authorized ? (await client.getMe().catch(() => null)) as any : null;
          return {
            ok: true,
            connected,
            authorized,
            dc_id: dcId,
            self: me ? {
              id: Number(me.id),
              username: me.username ?? null,
              first_name: me.firstName ?? null,
              phone: me.phone ?? null,
            } : null,
          };
        } catch {
          return { ok: true, connected, authorized: false };
        }
      }

      // ── Forward messages in bulk ─────────────────────────────────────────────

      case "forward_messages_bulk": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const to = String(body.to ?? "").trim();
        if (!to) return { ok: false, error: "to is required (@username, numeric ID, etc.)" };
        const rawIds = body.message_ids;
        if (!Array.isArray(rawIds) || rawIds.length === 0)
          return { ok: false, error: "message_ids array is required" };
        const msgIds = (rawIds as unknown[]).map(Number).filter(Boolean);
        const fromPeer = body.from_chat_id ? Number(body.from_chat_id) : peer;
        const targetPeer: number | string = /^-?\d+$/.test(to) ? Number(to) : to;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withRetry(() => client!.forwardMessages(targetPeer as any, {
          messages: msgIds,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fromPeer: fromPeer as any,
        }));
        return { ok: true, forwarded: msgIds.length, to };
      }

      // ── Contacts improvements ────────────────────────────────────────────────

      case "get_mutual_contacts": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        // mutual contacts = contacts who are in our contact list
        // contacts.GetContacts already returns the users we have mutual contact with
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.contacts.GetContacts({
          hash: BigInt(0) as unknown as import("big-integer").BigInteger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const users = (result.users ?? []) as any[];
        if (users.length === 0) return { ok: true, text: "No mutual contacts.", count: 0 };
        const formatted = users
          .filter((u) => u.mutualContact === true || u.contact === true)
          .map((u) => {
            const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
            const username = u.username ? ` @${u.username}` : "";
            const phone = u.phone ? ` +${u.phone}` : "";
            return `[id:${Number(u.id)}]${username} ${name}${phone}`;
          });
        return { ok: true, text: formatted.join("\n") || "No mutual contacts.", count: formatted.length };
      }

      case "import_contacts": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const rawContacts = body.contacts;
        if (!Array.isArray(rawContacts) || rawContacts.length === 0)
          return { ok: false, error: "contacts must be a non-empty array of {phone, first_name, last_name?}" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const contacts = (rawContacts as any[]).map((c, i) => {
          const phone = String(c.phone ?? "");
          const firstName = String(c.first_name ?? "");
          const lastName = String(c.last_name ?? "");
          if (!phone || !firstName) throw new Error(`Contact[${i}]: phone and first_name are required`);
          return new Api.InputPhoneContact({
            clientId: BigInt(Date.now() + i) as unknown as import("big-integer").BigInteger,
            phone,
            firstName,
            lastName,
          });
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.contacts.ImportContacts({ contacts }))) as any;
        const imported = Number(result?.imported?.length ?? 0);
        const notImported = Number(result?.retryContacts?.length ?? 0);
        return { ok: true, imported, not_imported: notImported };
      }

      // ── List media in chat ───────────────────────────────────────────────────

      case "list_media": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const limit = Math.min(100, Number(body.limit ?? 20));
        const mediaType = String(body.type ?? "all");

        const filterMap: Record<string, unknown> = {
          photo: new Api.InputMessagesFilterPhotos(),
          video: new Api.InputMessagesFilterVideo(),
          document: new Api.InputMessagesFilterDocument(),
          voice: new Api.InputMessagesFilterVoice(),
          audio: new Api.InputMessagesFilterMusic(),
          all: new Api.InputMessagesFilterPhotoVideo(),
        };
        const filter = filterMap[mediaType] ?? new Api.InputMessagesFilterPhotoVideo();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.Search({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          q: "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          filter: filter as any,
          minDate: 0,
          maxDate: 0,
          offsetId: 0,
          addOffset: 0,
          limit,
          maxId: 0,
          minId: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hash: BigInt(0) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msgs = (result.messages ?? []) as any[];
        if (msgs.length === 0) return { ok: true, text: `No ${mediaType} media found.`, count: 0 };

        const lines = msgs.map((m) => {
          const date = new Date((m.date ?? 0) * 1000).toISOString();
          const mediaClass = m.media?.className ?? "unknown";
          const fileName = m.media?.document?.attributes
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ?.find((a: any) => a.className === "DocumentAttributeFilename")?.fileName ?? "";
          return `[msg:${m.id} ${date}] [${mediaClass}]${fileName ? ` ${fileName}` : ""} ${m.message || ""}`.trim();
        });
        return { ok: true, text: lines.join("\n"), count: msgs.length, type: mediaType };
      }

      // ── Poll results details ─────────────────────────────────────────────────

      case "get_poll_results": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetPollResults({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          msgId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;

        // Extract UpdateMessagePoll from the updates
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pollUpdate = (result?.updates ?? []).find((u: any) =>
          u.className === "UpdateMessagePoll",
        ) as any;

        if (!pollUpdate) {
          return { ok: false, error: "Poll results not available for this message. Ensure it is a poll message." };
        }

        const poll = pollUpdate.poll;
        const results = pollUpdate.results;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const answers = (poll?.answers ?? []) as any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const answerVoters = (results?.results ?? []) as any[];
        const totalVoters = Number(results?.totalVoters ?? 0);

        const breakdown = answers.map((answer, i) => {
          const voter = answerVoters[i];
          const count = Number(voter?.voters ?? 0);
          const pct = totalVoters > 0 ? Math.round((count / totalVoters) * 100) : 0;
          const chosen = voter?.chosen ?? false;
          const text = typeof answer.text === "string" ? answer.text : (answer.text?.text ?? `Option ${i}`);
          return { index: i, text, votes: count, percentage: pct, you_voted: chosen };
        });

        return {
          ok: true,
          message_id: msgId,
          question: typeof poll?.question === "string" ? poll.question : (poll?.question?.text ?? ""),
          total_voters: totalVoters,
          closed: poll?.closed ?? false,
          options: breakdown,
        };
      }

      // ── Message context (messages around a specific ID) ─────────────────────

      case "get_message_context": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "message_id is required" };
        const contextSize = Math.min(20, Math.max(1, Number(body.context_size ?? 5)));

        // Fetch messages before (older) and after (newer) the target message
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const before = await client.getMessages(p as any, {
          limit: contextSize,
          offsetId: msgId,
          addOffset: 0,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const after = await client.getMessages(p as any, {
          limit: contextSize,
          offsetId: msgId + 1,
          addOffset: -contextSize,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const target = await client.getMessages(p as any, { ids: [msgId] });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatMsg = (m: any) => {
          const date = new Date((m.date ?? 0) * 1000).toISOString();
          const sender = m.senderId ? `[id:${Number(m.senderId)}]` : "[unknown]";
          const mark = m.id === msgId ? " ◀ TARGET" : "";
          return `[msg:${m.id} ${date}] ${sender}: ${m.message || "(media)"}${mark}`;
        };

        const allMessages = [
          ...before.reverse(),
          ...target,
          ...after.reverse(),
        ].sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);

        return {
          ok: true,
          target_id: msgId,
          context_size: contextSize,
          count: allMessages.length,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          text: allMessages.map((m: any) => formatMsg(m)).join("\n"),
        };
      }

      // ── Mark mentions and reactions as read ─────────────────────────────────

      case "mark_mentions_read": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.ReadMentions({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        return { ok: true, pts: result?.pts ?? 0, pts_count: result?.ptsCount ?? 0 };
      }

      case "mark_reactions_read": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.ReadReactions({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        return { ok: true, pts: result?.pts ?? 0, pts_count: result?.ptsCount ?? 0 };
      }

      // ── Similar channels and stats ──────────────────────────────────────────

      case "get_similar_channels": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.channels.GetChannelRecommendations({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: p as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chats = (result.chats ?? []) as any[];
        if (chats.length === 0) return { ok: true, text: "No similar channels found.", count: 0 };
        const formatted = chats.map((c) => {
          const username = c.username ? ` @${c.username}` : "";
          const members = c.participantsCount ? ` (${c.participantsCount} members)` : "";
          return `[chat:${Number(c.id)}]${username} ${c.title ?? "(no title)"}${members}`;
        });
        return { ok: true, text: formatted.join("\n"), count: chats.length };
      }

      case "get_channel_stats": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        try {
          // Try broadcast stats first (channels), then megagroup stats
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let result: any;
          try {
            result = await withRetry(() => client!.invoke(new Api.stats.GetBroadcastStats({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: p as any,
              dark: false,
            })));
          } catch {
            result = await withRetry(() => client!.invoke(new Api.stats.GetMegagroupStats({
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              channel: p as any,
              dark: false,
            })));
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = result as any;
          return {
            ok: true,
            period: r.period ? { min: r.period.minDate, max: r.period.maxDate } : null,
            followers: r.followers ? { current: Number(r.followers.current ?? 0), previous: Number(r.followers.previous ?? 0) } : null,
            views_per_post: r.viewsPerPost ? { current: Number(r.viewsPerPost.current ?? 0), previous: Number(r.viewsPerPost.previous ?? 0) } : null,
            shares_per_post: r.sharesPerPost ? { current: Number(r.sharesPerPost.current ?? 0) } : null,
            reactions_per_post: r.reactionsPerPost ? { current: Number(r.reactionsPerPost.current ?? 0) } : null,
            messages: r.messages ? { current: Number(r.messages.current ?? 0), previous: Number(r.messages.previous ?? 0) } : null,
          };
        } catch (err) {
          return { ok: false, error: `Stats not available: ${err instanceof Error ? err.message : String(err)}` };
        }
      }

      // ── Emoji status ────────────────────────────────────────────────────────

      case "set_emoji_status": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const docIdRaw = body.document_id;
        if (!docIdRaw) {
          // Clear emoji status
          await withRetry(() => client!.invoke(new Api.account.UpdateEmojiStatus({
            emojiStatus: new Api.EmojiStatusEmpty(),
          })));
          return { ok: true, cleared: true };
        }
        const documentId = BigInt(String(docIdRaw)) as unknown as import("big-integer").BigInteger;
        const until = typeof body.until === "number" ? body.until : undefined;
        // EmojiStatusUntil may not exist in all layer versions; use EmojiStatus and pass until as any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const emojiStatus = new Api.EmojiStatus({ documentId, ...(until ? { until } : {}) } as any);
        await withRetry(() => client!.invoke(new Api.account.UpdateEmojiStatus({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          emojiStatus: emojiStatus as any,
        })));
        return { ok: true, document_id: String(docIdRaw), until: until ?? null };
      }

      case "get_emoji_status": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const me = await client.getMe() as any;
        const status = me?.emojiStatus;
        if (!status || status.className === "EmojiStatusEmpty") {
          return { ok: true, emoji_status: null };
        }
        return {
          ok: true,
          emoji_status: {
            document_id: status.documentId ? String(status.documentId) : null,
            until: status.until ?? null,
            className: status.className,
          },
        };
      }

      // ── Channel management ───────────────────────────────────────────────────

      case "set_channel_username": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const username = String(body.username ?? ""); // empty string removes username
        await withRetry(() => client!.invoke(new Api.channels.UpdateUsername({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: p as any,
          username,
        })));
        return { ok: true, username: username || null };
      }

      case "set_discussion_group": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const channelPeer = body.channel_id ? Number(body.channel_id) : peer;
        const groupId = Number(body.group_id);
        if (!groupId) return { ok: false, error: "group_id (the supergroup to use as discussion) is required" };
        await withRetry(() => client!.invoke(new Api.channels.SetDiscussionGroup({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          broadcast: channelPeer as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          group: groupId as any,
        })));
        return { ok: true, channel_id: channelPeer, group_id: groupId };
      }

      // ── Forum topic control ──────────────────────────────────────────────────

      case "close_forum_topic": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const topicId = Number(body.topic_id);
        if (!topicId) return { ok: false, error: "topic_id is required" };
        await withRetry(() => client!.invoke(new Api.channels.EditForumTopic({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: p as any,
          topicId,
          closed: true,
        })));
        return { ok: true, topic_id: topicId, closed: true };
      }

      case "reopen_forum_topic": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const topicId = Number(body.topic_id);
        if (!topicId) return { ok: false, error: "topic_id is required" };
        await withRetry(() => client!.invoke(new Api.channels.EditForumTopic({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: p as any,
          topicId,
          closed: false,
        })));
        return { ok: true, topic_id: topicId, closed: false };
      }

      case "delete_forum_topic": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const topicId = Number(body.topic_id);
        if (!topicId) return { ok: false, error: "topic_id is required" };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.channels.DeleteTopicHistory({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: p as any,
          topMsgId: topicId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        return { ok: true, topic_id: topicId, deleted_messages: result?.pts ?? 0 };
      }

      // ── Telegram scheduled messages (server-side) ───────────────────────────

      case "get_scheduled_messages": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetScheduledHistory({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          hash: BigInt(0) as unknown as import("big-integer").BigInteger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msgs = (result.messages ?? []) as any[];
        if (msgs.length === 0) return { ok: true, text: "No scheduled messages.", count: 0 };
        const lines = msgs.map((m) => {
          const schedDate = m.date ? new Date(m.date * 1000).toISOString() : "unknown time";
          return `[id:${m.id} scheduled:${schedDate}] ${m.message || "(media)"}`;
        });
        return { ok: true, text: lines.join("\n"), count: msgs.length };
      }

      case "delete_scheduled_message": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const rawIds = body.message_id;
        const ids: number[] = Array.isArray(rawIds)
          ? (rawIds as unknown[]).map(Number)
          : [Number(rawIds)];
        if (!ids.length || !ids[0]) return { ok: false, error: "message_id (or array) is required" };
        await withRetry(() => client!.invoke(new Api.messages.DeleteScheduledMessages({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          id: ids,
        })));
        return { ok: true, deleted: ids.length };
      }

      // ── Resolve peer / entity lookup ────────────────────────────────────────

      case "resolve_peer": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const query = String(body.query ?? "").trim();
        if (!query) return { ok: false, error: "query is required (@username, +phone, or numeric ID)" };
        const target: number | string = /^-?\d+$/.test(query) ? Number(query) : query;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entity = await client.getEntity(target as any).catch(() => null);
        if (!entity) return { ok: false, error: `Could not resolve "${query}" — check the username, phone, or ID` };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = entity as any;
        const type = e.className === "User" ? (e.bot ? "bot" : "user")
          : e.className === "Channel" ? (e.megagroup ? "supergroup" : "channel")
          : e.className === "Chat" ? "group"
          : "unknown";
        return {
          ok: true,
          id: Number(e.id),
          type,
          first_name: e.firstName ?? null,
          last_name: e.lastName ?? null,
          username: e.username ?? null,
          phone: e.phone ?? null,
          title: e.title ?? null,
          is_bot: e.bot ?? false,
          verified: e.verified ?? false,
        };
      }

      // ── Convert group to supergroup ─────────────────────────────────────────

      case "convert_to_supergroup": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        // MigrateChat takes a basic group ID (positive, without the - prefix)
        const chatId = Math.abs(p);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.MigrateChat({
          chatId: BigInt(chatId) as unknown as import("big-integer").BigInteger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        const newChatId = result?.chats?.find?.((c: { megagroup?: boolean }) => c.megagroup)?.id;
        return { ok: true, new_supergroup_id: newChatId ? `-100${BigInt(newChatId).toString()}` : null };
      }

      // ── Protected content ───────────────────────────────────────────────────

      case "set_protected_content": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const enabled = body.enabled !== false;
        await withRetry(() => client!.invoke(new Api.messages.ToggleNoForwards({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          enabled,
        })));
        return { ok: true, protected_content: enabled };
      }

      // ── Auto-delete timer ───────────────────────────────────────────────────

      case "set_auto_delete": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const validSeconds = [0, 86400, 604800, 2592000]; // off, 1day, 1week, 1month
        const seconds = Number(body.seconds ?? 0);
        if (!validSeconds.includes(seconds))
          return { ok: false, error: `seconds must be one of: ${validSeconds.join(", ")} (0=off, 86400=1day, 604800=1week, 2592000=1month)` };
        await withRetry(() => client!.invoke(new Api.messages.SetHistoryTTL({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          period: seconds,
        })));
        const label = seconds === 0 ? "off" : seconds === 86400 ? "1 day" : seconds === 604800 ? "1 week" : "1 month";
        return { ok: true, seconds, label };
      }

      // ── Join request management ─────────────────────────────────────────────

      case "get_join_requests": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        const limit = Math.min(100, Number(body.limit ?? 20));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await withRetry(() => client!.invoke(new Api.messages.GetChatInviteImporters({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          requested: true,
          limit,
          offsetDate: 0,
          offsetUser: new Api.InputUserEmpty(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }))) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const importers = (result.importers ?? []) as any[];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const usersMap = new Map<string, any>((result.users ?? []).map((u: any) => [String(u.id), u]));
        const formatted = importers.map((imp) => {
          const u = usersMap.get(String(imp.userId));
          const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || String(imp.userId)) : String(imp.userId);
          const date = new Date((imp.date ?? 0) * 1000).toISOString();
          return { user_id: Number(imp.userId), name, date, about: imp.about ?? null };
        });
        return { ok: true, count: formatted.length, requests: formatted };
      }

      case "approve_join_request": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id (numeric Telegram user ID) is required" };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        await withRetry(() => client!.invoke(new Api.messages.HideChatJoinRequest({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          approved: true,
        })));
        return { ok: true, user_id: userId, approved: true };
      }

      case "decline_join_request": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
        const userId = Number(body.user_id);
        if (!userId) return { ok: false, error: "user_id (numeric Telegram user ID) is required" };
        const p = body.chat_id ? Number(body.chat_id) : peer;
        await withRetry(() => client!.invoke(new Api.messages.HideChatJoinRequest({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: p as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          approved: false,
        })));
        return { ok: true, user_id: userId, approved: false };
      }

      // ── Chat activity ───────────────────────────────────────────────────────

      case "get_chat_activity": {
        const client = getClient();
        if (!client) return { ok: false, error: "User client not connected." };
        const actPeer = body.chat_id ? Number(body.chat_id) : peer;
        const actLimit = Math.min(Number(body.limit ?? 200), 500);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages = await client.getMessages(actPeer as any, { limit: actLimit }) as any[];
        // Build sender counts — GramJS messages include a _sender cache on the message object
        const counts = new Map<string, { name: string; count: number }>();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nameCache = new Map<string, string>();
        for (const msg of messages) {
          const sid = String(msg.senderId ?? msg.fromId?.userId ?? "unknown");
          if (!counts.has(sid)) counts.set(sid, { name: sid, count: 0 });
          counts.get(sid)!.count++;
          if (!nameCache.has(sid)) {
            // Try to get display name from cached sender entity
            const sender = msg._sender ?? msg.sender;
            if (sender) {
              const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username || sender.title || sid;
              nameCache.set(sid, name);
              counts.get(sid)!.name = name;
            }
          }
        }
        const sorted = [...counts.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([userId, v]) => ({ userId, name: v.name, messages: v.count }));
        return { ok: true, sample_size: messages.length, activity: sorted };
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
