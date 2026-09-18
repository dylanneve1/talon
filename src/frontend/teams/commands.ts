/**
 * Teams slash commands — /reset, /status, /help. Each answers with a card
 * through the webhook and ignores delivery failures; the poll loop moves on
 * either way.
 */

import { log } from "../../util/log.js";
import { resolveModel } from "../../core/models/catalog.js";
import { resolveChatBackend } from "../../core/engine/backend-controller/index.js";
import { getSessionInfo } from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { performSessionReset } from "../presentation/session-status.js";
import { buildCacheDisplay } from "../presentation/status-context.js";
import { buildAdaptiveCard } from "./formatting.js";
import type { ChatMessage } from "./graph.js";
import { postCard } from "./outbound.js";
import type { TeamsRuntime } from "./runtime.js";

const HELP_TEXT =
  "**Commands:**\n- `/reset` — clear session & history\n- `/status` — session stats\n- `/help` — this message";

type Fact = { title: string; value: string };

function reply(
  runtime: TeamsRuntime,
  card: Record<string, unknown>,
): Promise<unknown> {
  return postCard(runtime.webhookUrl, card).catch(() => {});
}

async function handleReset(
  runtime: TeamsRuntime,
  msg: ChatMessage,
  talonChatId: string,
): Promise<void> {
  await performSessionReset(
    talonChatId,
    resolveChatBackend(talonChatId, runtime.gateway.backend),
  );
  log("teams", `Session reset by ${msg.senderName}`);
  await reply(runtime, buildAdaptiveCard("Session cleared."));
}

function statusFacts(runtime: TeamsRuntime, talonChatId: string): Fact[] {
  const info = getSessionInfo(talonChatId);
  const u = info.usage;
  const cache = buildCacheDisplay({
    cacheMetrics: runtime.gateway.backend?.cacheMetrics,
    inputTokens: u.totalInputTokens,
    cacheRead: u.totalCacheRead,
    cacheWrite: u.totalCacheWrite,
  });
  const rawModel =
    getChatSettings(talonChatId).model ?? (runtime.config.model as string);
  const model = resolveModel(rawModel)?.displayName ?? rawModel;
  const avgMs = info.turns > 0 ? Math.round(u.totalResponseMs / info.turns) : 0;
  const ctxUsed = u.contextTokens || u.lastPromptTokens;
  const ctxMax = u.contextWindow;
  const ctxPct =
    ctxMax > 0 ? Math.min(100, Math.round((ctxUsed / ctxMax) * 100)) : 0;
  return [
    { title: "Model", value: model },
    { title: "Turns", value: String(info.turns) },
    {
      title: "Context",
      value: `${(ctxUsed / 1000).toFixed(0)}K / ${(ctxMax / 1000).toFixed(0)}K (${ctxPct}%)`,
    },
    ...(cache ? [{ title: "Cache", value: `${cache.hitPct}% hit` }] : []),
    { title: "Input", value: `${u.totalInputTokens.toLocaleString()} tokens` },
    {
      title: "Output",
      value: `${u.totalOutputTokens.toLocaleString()} tokens`,
    },
    {
      title: "Avg response",
      value: avgMs > 0 ? `${(avgMs / 1000).toFixed(1)}s` : "—",
    },
  ];
}

function buildStatusCard(
  runtime: TeamsRuntime,
  talonChatId: string,
): Record<string, unknown> {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: "**Session**",
              wrap: true,
              size: "Medium",
              weight: "Bolder",
            },
            { type: "FactSet", facts: statusFacts(runtime, talonChatId) },
          ],
        },
      },
    ],
  };
}

type CommandHandler = (
  runtime: TeamsRuntime,
  msg: ChatMessage,
  talonChatId: string,
) => Promise<void>;

/** Exact-match table: the whole message, trimmed and lowercased, is the key. */
export const TEAMS_COMMANDS: Record<string, CommandHandler> = Object.assign(
  Object.create(null) as Record<string, CommandHandler>,
  {
    "/reset": handleReset,
    "/status": async (runtime, _msg, talonChatId) => {
      await reply(runtime, buildStatusCard(runtime, talonChatId));
    },
    "/help": async (runtime) => {
      await reply(runtime, buildAdaptiveCard(HELP_TEXT));
    },
  } satisfies Record<string, CommandHandler>,
);

/** Returns true when `msg` was a slash command and has been answered. */
export async function handleSlashCommand(
  runtime: TeamsRuntime,
  msg: ChatMessage,
  talonChatId: string,
): Promise<boolean> {
  const handler = TEAMS_COMMANDS[msg.text.trim().toLowerCase()];
  if (!handler) return false;
  await handler(runtime, msg, talonChatId);
  return true;
}
