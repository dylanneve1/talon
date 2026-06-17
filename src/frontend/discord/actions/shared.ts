/**
 * Shared helpers for Discord action handlers: clean error mapping, channel
 * resolution, and button-row construction.
 */

import {
  type Client,
  type TextBasedChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { ActionResult } from "../../../core/types.js";
import { lookupDiscordChat } from "../handlers/index.js";
import { safeSlice } from "../formatting.js";
import { logWarn } from "../../../util/log.js";
import { mapDiscordError } from "../errors.js";

/** Run a Discord action; convert DiscordAPIError into a clean ActionResult. */
export async function tryAction(
  context: string,
  fn: () => Promise<ActionResult>,
): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapDiscordError(err, context);
    if (mapped) return mapped;
    return {
      ok: false,
      error: `${context} failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

export async function resolveChannel(
  client: Client,
  numericChatId: number,
): Promise<TextBasedChannel | null> {
  const info = lookupDiscordChat(numericChatId);
  if (!info) return null;
  try {
    const ch = await client.channels.fetch(info.channelId);
    if (ch && "send" in ch && (ch as TextBasedChannel).isSendable?.()) {
      return ch as TextBasedChannel;
    }
    if (info.userId) {
      const user = await client.users.fetch(info.userId);
      const dm = await user.createDM();
      return dm as TextBasedChannel;
    }
    return null;
  } catch (err) {
    logWarn(
      "discord",
      `resolveChannel failed for chat ${numericChatId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export function buildButtonRows(
  rows: Array<
    Array<{
      text: string;
      url?: string;
      callback_data?: string;
      style?: string;
    }>
  >,
): ActionRowBuilder<ButtonBuilder>[] {
  const out: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const row of rows.slice(0, 5)) {
    const arb = new ActionRowBuilder<ButtonBuilder>();
    for (const btn of row.slice(0, 5)) {
      const b = new ButtonBuilder().setLabel(safeSlice(btn.text || "•", 80));
      if (btn.url) {
        b.setStyle(ButtonStyle.Link).setURL(btn.url);
      } else {
        const styleMap: Record<string, ButtonStyle> = {
          primary: ButtonStyle.Primary,
          secondary: ButtonStyle.Secondary,
          success: ButtonStyle.Success,
          danger: ButtonStyle.Danger,
        };
        const style =
          styleMap[btn.style ?? "secondary"] ?? ButtonStyle.Secondary;
        // Namespace AI-generated custom_ids under `ai:` so the callback router
        // never confuses them with system custom_ids like `settings:done`.
        // The router strips the prefix before forwarding to the agent.
        const raw = btn.callback_data || btn.text || "";
        const id = `ai:${safeSlice(raw, 96)}`;
        b.setStyle(style).setCustomId(id);
      }
      arb.addComponents(b);
    }
    out.push(arb);
  }
  return out;
}
