/**
 * Recording action handler — captures every gateway action body for tests.
 *
 * Drop-in replacement for the production frontend handler when a test wants
 * to drive the SDK→MCP→bridge→gateway chain end-to-end without hitting an
 * external service. Returns plausible synthetic responses so `tool.execute()`
 * resolves cleanly (synthetic message_ids that never collide with real
 * Telegram IDs but are deterministic per-handler-instance).
 *
 * Used by `talon-mcp-functional.test.ts` and any future MCP-tier suites.
 */

import type { FrontendActionHandler, ActionResult } from "../../core/types.js";

export interface CapturedAction {
  body: Record<string, unknown>;
  chatId: number;
  /** Sequence number — first capture is 0, second is 1, etc. */
  seq: number;
}

export interface RecordingHandler {
  /** The FrontendActionHandler — register on Gateway via `setFrontendHandler`. */
  handler: FrontendActionHandler;
  /** Mutable array of every captured action, in order. */
  captured: CapturedAction[];
  /** Clear `captured` and reset the synthetic message_id counter. */
  reset: () => void;
  /** Filter `captured` by action name. */
  byAction: (action: string) => CapturedAction[];
  /** Most recent capture, or undefined if none. */
  last: () => CapturedAction | undefined;
  /** Synthetic responses the handler emits — useful for tests that want to
   *  override behavior on a per-action basis (e.g. simulate API errors). */
  respond: Map<
    string,
    (body: Record<string, unknown>) => ActionResult | Promise<ActionResult>
  >;
}

/**
 * Build a fresh RecordingHandler. The synthetic message_id counter starts
 * at the supplied seed (default 1000) so two suites running in the same
 * process don't collide — pass distinct seeds if needed.
 */
export function makeRecordingHandler(
  options: { seed?: number } = {},
): RecordingHandler {
  const captured: CapturedAction[] = [];
  const respond = new Map<
    string,
    (body: Record<string, unknown>) => ActionResult | Promise<ActionResult>
  >();
  let nextMessageId = options.seed ?? 1000;

  const handler: FrontendActionHandler = async (body, chatId) => {
    const seq = captured.length;
    captured.push({ body: { ...body }, chatId, seq });

    const action = String(body.action ?? "");
    const override = respond.get(action);
    if (override) return override(body);

    // Default synthetic responses — shaped like the production Telegram
    // action handler returns, so tool.execute() resolves cleanly without
    // needing to think about response shapes.
    switch (action) {
      case "send_message":
      case "send_message_with_buttons":
      case "reply_to":
      case "send_photo":
      case "send_video":
      case "send_audio":
      case "send_voice":
      case "send_animation":
      case "send_file":
      case "send_sticker":
      case "send_poll":
      case "send_location":
      case "send_contact":
      case "send_dice":
        return { ok: true, message_id: nextMessageId++ };

      case "react":
      case "edit_message":
      case "edit_message_with_buttons":
      case "delete_message":
      case "forward_message":
      case "pin_message":
      case "unpin_message":
      case "stop_poll":
      case "send_chat_action":
        return { ok: true };

      // Read paths — return harmless empty payloads
      case "read_chat_history":
      case "search_chat_history":
      case "get_chat_info":
      case "list_chat_members":
      case "get_member_info":
      case "online_count":
      case "list_pinned":
      case "get_chat_admins":
      case "get_chat_member_count":
      case "get_message_by_id":
      case "list_media":
        return { ok: true, items: [] };

      default:
        return { ok: true };
    }
  };

  return {
    handler,
    captured,
    reset: () => {
      captured.length = 0;
      nextMessageId = options.seed ?? 1000;
      respond.clear();
    },
    byAction: (action) => captured.filter((c) => c.body.action === action),
    last: () => captured[captured.length - 1],
    respond,
  };
}
