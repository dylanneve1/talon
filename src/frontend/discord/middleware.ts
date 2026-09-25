/**
 * Discord middleware — wires up message events to handlers/.
 *
 * A single messageCreate listener filters out bots/system messages and
 * delegates to handleMessage. Every message is also pushed into the
 * in-memory history buffer so /admin commands and /status reflect real
 * activity, and every guild message registers its chat for pulse (DMs are
 * excluded because we always respond).
 */

import type { Client, Message } from "discord.js";
import { ChannelType } from "discord.js";
import type { TalonConfig } from "../../core/config/index.js";
import { pushMessage } from "../../storage/history.js";
import { registerChat } from "../../core/background/pulse/pulse.js";
import { deriveNumericChatId } from "../../core/frontend-runtime/chat-id.js";
import { handleMessage, getSenderName } from "./handlers/index.js";

export function registerMiddleware(client: Client, config: TalonConfig): void {
  client.on("messageCreate", (msg: Message) => {
    // Ignore self/bots/system here too — handleMessage checks again, but
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
    // Display names aren't addressable; the username is. Persist it so
    // later readers can mention the person rather than guess a handle.
    const senderHandle = msg.author.username;
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
        senderHandle,
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
        senderHandle,
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
