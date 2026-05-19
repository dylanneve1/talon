/**
 * Discord middleware — wires up message events to handlers.ts.
 *
 * Equivalent to src/frontend/telegram/middleware.ts. We attach a single
 * messageCreate listener that filters out bots/system messages and delegates
 * to handleMessage. We also push every message into the in-memory history
 * buffer so /admin commands and /status reflect real activity.
 *
 * Discord-specific behavior:
 *  - We don't have a separate "my_chat_member" event; instead, when the bot
 *    is removed from a guild we get `guildDelete`. The handler in index.ts
 *    handles that to revoke access.
 *  - Every guild message gets the chat registered for pulse so periodic
 *    check-ins work (DMs are excluded because we always respond).
 */

import type { Client, Message } from "discord.js";
import { ChannelType } from "discord.js";
import type { TalonConfig } from "../../util/config.js";
import { pushMessage } from "../../storage/history.js";
import { registerChat } from "../../core/pulse.js";
import { deriveNumericChatId } from "../../util/chat-id.js";
import { handleMessage, getSenderName } from "./handlers.js";

export function registerMiddleware(client: Client, config: TalonConfig): void {
  client.on("messageCreate", (msg: Message) => {
    // Ignore self/bots/system here too — handlers.ts will check again, but
    // we don't even want to record those in history.
    if (msg.author.bot || msg.system) return;
    if (msg.author.id === client.user?.id) return;

    const isGroup = msg.channel.type !== ChannelType.DM;
    const chatId = isGroup
      ? `discord_guild_${msg.guildId}_${msg.channelId}`
      : `discord_dm_${msg.author.id}`;

    if (isGroup) registerChat(chatId);

    // Push to history buffer — text or attachment placeholder
    const numericMessageId = deriveNumericChatId(msg.id);
    const senderId = deriveNumericChatId(msg.author.id);
    const senderName = getSenderName(msg);
    const replyToMsgId = msg.reference?.messageId
      ? deriveNumericChatId(msg.reference.messageId)
      : undefined;
    const timestamp = msg.createdTimestamp;

    if (msg.attachments.size > 0) {
      const first = msg.attachments.first();
      const ct = first?.contentType ?? "";
      const mediaType = ct.startsWith("image/")
        ? "photo"
        : ct.startsWith("video/")
          ? "video"
          : ct.startsWith("audio/")
            ? "voice"
            : "document";
      pushMessage(chatId, {
        msgId: numericMessageId,
        senderId,
        senderName,
        text: msg.content || `(${mediaType})`,
        replyToMsgId,
        timestamp,
        mediaType,
      });
    } else if (msg.content) {
      pushMessage(chatId, {
        msgId: numericMessageId,
        senderId,
        senderName,
        text: msg.content,
        replyToMsgId,
        timestamp,
      });
    }

    // Hand off to handler (does access control, queue, dispatch)
    handleMessage(client, msg, config).catch(() => {
      /* logged inside */
    });
  });
}
