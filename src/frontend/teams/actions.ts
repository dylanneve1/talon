/**
 * Teams-specific action handlers.
 *
 * Handles MCP tool actions that require the Teams Bot API.
 * Platform-agnostic actions (cron, fetch_url, history) are handled
 * by core/gateway-actions.ts before this is called.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  TurnContext,
  MessageFactory,
  CardFactory,
  type BotFrameworkAdapter,
} from "botbuilder";
import { incrementMessageCount } from "../../core/gateway.js";
import { getConversationReference } from "./conversation-store.js";
import type { ActionResult } from "../../core/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get a TurnContext for proactive messaging (outside of a turn handler).
 * Returns null if no stored reference exists for this conversation.
 */
async function withProactiveContext<T>(
  adapter: BotFrameworkAdapter,
  chatId: string,
  fn: (context: TurnContext) => Promise<T>,
): Promise<T | null> {
  const ref = getConversationReference(chatId);
  if (!ref) return null;
  let result: T | null = null;
  await adapter.continueConversation(ref, async (context) => {
    result = await fn(context);
  });
  return result;
}

const TEAMS_MAX_TEXT = 28_000; // Teams limit is ~28KB

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Teams action handler bound to a specific adapter instance.
 * Returns a FrontendActionHandler that the gateway calls for Teams-specific actions.
 */
export function createTeamsActionHandler(adapter: BotFrameworkAdapter) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  return async (
    body: Record<string, unknown>,
    chatId: string,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;

    switch (action) {
      // ── Messaging ─────────────────────────────────────────────────────
      case "send_message": {
        const text = String(body.text ?? "");
        if (text.length > TEAMS_MAX_TEXT)
          return { ok: false, error: `Text too long (max ${TEAMS_MAX_TEXT})` };
        incrementMessageCount();
        const result = await withProactiveContext(adapter, chatId, async (ctx) => {
          const sent = await ctx.sendActivity(MessageFactory.text(text));
          return sent?.id;
        });
        return { ok: true, message_id: result ?? undefined };
      }

      case "reply_to": {
        const text = String(body.text ?? "");
        incrementMessageCount();
        const result = await withProactiveContext(adapter, chatId, async (ctx) => {
          const sent = await ctx.sendActivity(MessageFactory.text(text));
          return sent?.id;
        });
        return { ok: true, message_id: result ?? undefined };
      }

      case "react":
        // Teams reaction API is limited — acknowledge silently
        return { ok: true };

      case "edit_message": {
        const text = String(body.text ?? "");
        const activityId = String(body.message_id ?? "");
        if (!activityId) return { ok: false, error: "Missing message_id" };
        await withProactiveContext(adapter, chatId, async (ctx) => {
          const activity = MessageFactory.text(text);
          activity.id = activityId;
          await ctx.updateActivity(activity);
        });
        return { ok: true };
      }

      case "delete_message": {
        const activityId = String(body.message_id ?? "");
        if (!activityId) return { ok: false, error: "Missing message_id" };
        await withProactiveContext(adapter, chatId, async (ctx) => {
          await ctx.deleteActivity(activityId);
        });
        return { ok: true };
      }

      case "send_chat_action":
        await withProactiveContext(adapter, chatId, async (ctx) => {
          await ctx.sendActivity({ type: "typing" });
        });
        return { ok: true };

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        const rows = body.rows as
          | Array<Array<{ text: string; url?: string; callback_data?: string }>>
          | undefined;
        if (!rows) return { ok: false, error: "Missing button rows" };
        incrementMessageCount();

        // Build Adaptive Card with action buttons
        const actions = rows.flat().map((btn) => {
          if (btn.url) {
            return { type: "Action.OpenUrl", title: btn.text, url: btn.url };
          }
          return {
            type: "Action.Submit",
            title: btn.text,
            data: { callback_data: btn.callback_data ?? btn.text },
          };
        });

        const card = CardFactory.adaptiveCard({
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.3",
          body: [{ type: "TextBlock", text, wrap: true }],
          actions,
        });

        const result = await withProactiveContext(adapter, chatId, async (ctx) => {
          const sent = await ctx.sendActivity(MessageFactory.attachment(card));
          return sent?.id;
        });
        return { ok: true, message_id: result ?? undefined };
      }

      case "schedule_message": {
        const text = String(body.text ?? "");
        const delaySec = Math.max(1, Math.min(3600, Number(body.delay_seconds ?? 60)));
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(async () => {
          try {
            await withProactiveContext(adapter, chatId, async (ctx) => {
              await ctx.sendActivity(MessageFactory.text(text));
            });
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

      // ── Media ──────────────────────────────────────────────────────────
      case "send_file":
      case "send_photo":
      case "send_video":
      case "send_animation":
      case "send_voice": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        incrementMessageCount();

        if (action === "send_file") {
          const stat = statSync(filePath);
          if (stat.size > 49 * 1024 * 1024)
            return { ok: false, error: "File too large (max 49MB)" };
        }

        const data = readFileSync(filePath);
        const fileName = basename(filePath);
        const base64 = data.toString("base64");

        // Determine content type
        const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
        const contentTypes: Record<string, string> = {
          jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
          gif: "image/gif", webp: "image/webp", mp4: "video/mp4",
          ogg: "audio/ogg", mp3: "audio/mpeg", pdf: "application/pdf",
        };
        const contentType = contentTypes[ext] ?? "application/octet-stream";

        const attachment = {
          name: fileName,
          contentType,
          contentUrl: `data:${contentType};base64,${base64}`,
        };

        const result = await withProactiveContext(adapter, chatId, async (ctx) => {
          const msg = MessageFactory.contentUrl(
            attachment.contentUrl,
            attachment.contentType,
            attachment.name,
          );
          if (caption) msg.text = caption;
          const sent = await ctx.sendActivity(msg);
          return sent?.id;
        });
        return { ok: true, message_id: result ?? undefined };
      }

      // ── Chat info ─────────────────────────────────────────────────────
      case "get_chat_info": {
        const ref = getConversationReference(chatId);
        return {
          ok: true,
          id: chatId,
          type: ref?.conversation?.conversationType ?? "personal",
          title: ref?.conversation?.name ?? "Teams Chat",
        };
      }

      // ── Unsupported Telegram-specific actions ─────────────────────────
      case "pin_message":
      case "unpin_message":
      case "forward_message":
      case "copy_message":
      case "send_sticker":
      case "send_poll":
      case "send_dice":
      case "send_location":
      case "send_contact":
      case "get_sticker_pack":
      case "download_sticker":
      case "save_sticker_pack":
      case "download_media":
      case "online_count":
      case "get_pinned_messages":
        return { ok: false, error: `"${action}" is not supported on Teams` };

      case "get_chat_admins":
      case "get_chat_member":
      case "get_chat_member_count":
      case "set_chat_title":
      case "set_chat_description":
      case "get_member_info":
        return { ok: false, error: `"${action}" requires Microsoft Graph API (not yet implemented)` };

      default:
        return null; // not a Teams action — delegate to shared actions
    }
  };
}
