/**
 * Registry-based action handler for userbot mode.
 *
 * Replaces the monolithic switch statement from userbot-actions.ts with a
 * Map<string, ActionHandler> that delegates to category-specific files.
 */

import type { Gateway } from "../../../../core/gateway.js";
import type { ActionResult } from "../../../../core/types.js";
import { registerMessagingActions } from "./messaging.js";
import { registerMediaActions } from "./media.js";
import { registerChatActions } from "./chat-management.js";
import { registerMemberActions } from "./member-management.js";
import { registerSearchActions } from "./search.js";
import { registerProfileActions } from "./profile.js";
import { registerStickerActions } from "./stickers.js";
import { registerStoryActions } from "./stories.js";
import { registerNotesActions } from "./notes.js";
import { registerWatchActions } from "./watches.js";
import { registerAdminActions } from "./admin.js";
import { registerDiscoveryActions } from "./discovery.js";
import { registerFolderActions } from "./folders.js";
import { registerPollActions } from "./polls.js";
import { registerPrivacyActions } from "./privacy.js";
import { registerLearningActions } from "./learning.js";
import { registerGoalActions } from "./goals.js";
import { registerRelationshipActions } from "./relationships.js";
import { registerSummaryActions } from "./summaries.js";
import { registerMonitoringActions } from "./monitoring.js";
import { registerJournalActions } from "./journal.js";

export type ActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
  peer: number,
  chatIdStr: string,
) => Promise<ActionResult | null>;

export type ActionRegistry = Map<string, ActionHandler>;

/**
 * Create a GramJS-based action handler.
 * The `recordOurMessage` callback is provided by userbot-frontend so that
 * messages we send can be tracked for reply-to-self detection.
 */
export function createUserbotActionHandler(
  gateway: Gateway,
  recordOurMessage: (chatId: string, msgId: number) => void,
) {
  const registry: ActionRegistry = new Map();

  // Register all action categories
  registerMessagingActions(registry, gateway, recordOurMessage);
  registerMediaActions(registry, gateway, recordOurMessage);
  registerChatActions(registry, gateway, recordOurMessage);
  registerMemberActions(registry, gateway, recordOurMessage);
  registerSearchActions(registry);
  registerProfileActions(registry);
  registerStickerActions(registry);
  registerStoryActions(registry);
  registerNotesActions(registry);
  registerWatchActions(registry);
  registerAdminActions(registry, gateway, recordOurMessage);
  registerDiscoveryActions(registry);
  registerFolderActions(registry);
  registerPollActions(registry, gateway, recordOurMessage);
  registerPrivacyActions(registry);
  registerLearningActions(registry);
  registerGoalActions(registry);
  registerRelationshipActions(registry);
  registerSummaryActions(registry);
  registerMonitoringActions(registry);
  registerJournalActions(registry);

  return async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const peer = chatId;
    const chatIdStr = String(chatId);
    const handler = registry.get(action);
    if (!handler) return null;
    return handler(body, chatId, peer, chatIdStr);
  };
}
