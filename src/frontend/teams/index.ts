/**
 * Teams frontend — bidirectional messaging via Power Automate + Graph API.
 *
 * SEND (Talon → Teams):  POST Adaptive Cards to a Power Automate workflow webhook URL.
 * RECEIVE (Teams → Talon): Poll group chat messages via Microsoft Graph API
 *                          using Chat.Read scope (no admin consent needed).
 *
 * No Azure AD app registration, no Bot Framework, no admin consent.
 */

import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/gateway.js";
import { log, logError } from "../../util/log.js";
import { deriveNumericChatId } from "../../util/chat-id.js";
import { createTeamsActionHandler } from "./actions.js";
import { splitTeamsMessage, buildAdaptiveCard } from "./formatting.js";
import {
  initGraphClient,
  type GraphClient,
  type ChatMessage,
} from "./graph.js";
import { proxyFetch } from "./proxy-fetch.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TeamsFrontend = {
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Frontend factory ─────────────────────────────────────────────────────────

export function createTeamsFrontend(
  config: TalonConfig,
  gateway: Gateway,
): TeamsFrontend {
  const webhookUrl = (config as Record<string, unknown>)
    .teamsWebhookUrl as string;
  const botDisplayName =
    ((config as Record<string, unknown>).teamsBotDisplayName as string) || "";
  const pollIntervalMs =
    ((config as Record<string, unknown>).teamsGraphPollMs as number) || 10_000;
  const configChatTopic =
    ((config as Record<string, unknown>).teamsChatTopic as string) || "";

  let graphClient: GraphClient | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeenMessageId: string | null = null;
  let myUserId: string | null = null;
  let polling = false;

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    context,

    // Teams has no typing indicator via webhooks
    sendTyping: async () => {},

    sendMessage: async (_chatId: number, text: string) => {
      if (!text.trim()) return;
      try {
        const chunks = splitTeamsMessage(text);
        for (const chunk of chunks) {
          const card = buildAdaptiveCard(chunk);
          await proxyFetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(card),
            signal: AbortSignal.timeout(15_000),
          });
        }
      } catch (err) {
        logError(
          "teams",
          `sendMessage failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      // Register action handler with the gateway
      gateway.setFrontendHandler(createTeamsActionHandler(webhookUrl, gateway));
      const port = await gateway.start(19876);
      log("teams", `Gateway on port ${port}`);

      // Authenticate with Microsoft Graph
      log("teams", "Initializing Microsoft Graph client...");
      graphClient = await initGraphClient();

      // Get our own user ID (to filter out our own messages)
      const me = await graphClient.getMe();
      myUserId = me.id;
      log("teams", `Authenticated as: ${me.displayName} (${me.id})`);

      // Discover or load chat
      let chatId = graphClient.getStoredChatId();

      if (!chatId) {
        log("teams", "No chat configured, discovering...");
        const chats = await graphClient.listChats();

        if (chats.length === 0) throw new Error("No chats found");

        // Try to match by topic name if configured
        let selectedChat = chats[0];
        if (configChatTopic) {
          const match = chats.find((c) =>
            c.topic?.toLowerCase().includes(configChatTopic.toLowerCase()),
          );
          if (match) selectedChat = match;
          else
            log(
              "teams",
              `No chat matching topic "${configChatTopic}", using most recent`,
            );
        }

        chatId = selectedChat.id;
        const topic = selectedChat.topic || "(unnamed chat)";

        graphClient.saveChatConfig(chatId, topic, myUserId);
        log("teams", `Configured chat: ${topic} [${selectedChat.chatType}]`);
      } else {
        log(
          "teams",
          `Using chat: ${graphClient.getStoredChatTopic() || chatId}`,
        );
      }

      // Seed lastSeenMessageId from current messages (don't process old messages)
      try {
        const existing = await graphClient.getChatMessages(chatId, 5);
        if (existing.length > 0) {
          lastSeenMessageId = existing[0].id;
          log("teams", `Seeded last message ID: ${lastSeenMessageId}`);
        }
      } catch (err) {
        logError(
          "teams",
          `Failed to seed messages: ${err instanceof Error ? err.message : err}`,
        );
      }
    },

    async start() {
      if (!graphClient) throw new Error("Graph client not initialized");

      const chatId = graphClient.getStoredChatId()!;
      const { execute } = await import("../../core/dispatcher.js");

      log("teams", "Teams frontend running");
      log("teams", `Send: Power Automate webhook`);
      log(
        "teams",
        `Receive: Graph API chat polling every ${pollIntervalMs / 1000}s`,
      );

      // ── Poll loop ──────────────────────────────────────────────────────
      async function poll(): Promise<void> {
        if (polling) return;
        polling = true;

        try {
          if (!graphClient) return;
          const messages = await graphClient.getChatMessages(chatId, 20);

          // Find new messages — messages are returned newest first
          // IDs are opaque strings, so compare by createdDateTime
          const newMessages: ChatMessage[] = [];
          for (const msg of messages) {
            if (lastSeenMessageId && msg.id === lastSeenMessageId) break;
            newMessages.push(msg);
          }

          if (newMessages.length > 0) {
            lastSeenMessageId = newMessages[0].id;
          }

          // Process in chronological order (oldest first)
          for (const msg of newMessages.reverse()) {
            if (!msg.text.trim()) continue;
            if (msg.edited) continue;

            // Skip bot/workflow messages by display name (echo loop prevention).
            // We do NOT filter by user ID — the authenticated user also sends
            // real messages that Talon should respond to.
            if (
              botDisplayName &&
              msg.senderName.toLowerCase() === botDisplayName.toLowerCase()
            ) {
              continue;
            }

            const numericChatId = deriveNumericChatId(msg.chatId);
            const talonChatId = `teams_chat_${msg.chatId}`;

            // ── Slash commands ──
            const trimmed = msg.text.trim().toLowerCase();
            if (trimmed === "/reset") {
              const { resetSession } =
                await import("../../storage/sessions.js");
              const { clearHistory } = await import("../../storage/history.js");
              resetSession(talonChatId);
              clearHistory(talonChatId);
              log("teams", `Session reset by ${msg.senderName}`);
              const card = buildAdaptiveCard("Session cleared.");
              await proxyFetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(card),
                signal: AbortSignal.timeout(15_000),
              }).catch(() => {});
              continue;
            }
            if (trimmed === "/status") {
              const { getSessionInfo } =
                await import("../../storage/sessions.js");
              const info = getSessionInfo(talonChatId);
              const u = info.usage;
              const cacheHit =
                u.totalInputTokens + u.totalCacheRead > 0
                  ? Math.round(
                      (u.totalCacheRead /
                        (u.totalInputTokens + u.totalCacheRead)) *
                        100,
                    )
                  : 0;
              const { getChatSettings } =
                await import("../../storage/chat-settings.js");
              const model = (
                getChatSettings(talonChatId).model ?? (config.model as string)
              ).replace("claude-", "");
              const avgMs =
                info.turns > 0 ? Math.round(u.totalResponseMs / info.turns) : 0;
              // Context info piped directly from Agent SDK — no model-name guessing
              const ctxUsed = u.contextTokens || u.lastPromptTokens;
              const ctxMax = u.contextWindow;
              const ctxPct =
                ctxMax > 0
                  ? Math.min(100, Math.round((ctxUsed / ctxMax) * 100))
                  : 0;
              const card = {
                type: "message",
                attachments: [
                  {
                    contentType: "application/vnd.microsoft.card.adaptive",
                    contentUrl: null,
                    content: {
                      type: "AdaptiveCard",
                      $schema:
                        "http://adaptivecards.io/schemas/adaptive-card.json",
                      version: "1.4",
                      body: [
                        {
                          type: "TextBlock",
                          text: "**Session**",
                          wrap: true,
                          size: "Medium",
                          weight: "Bolder",
                        },
                        {
                          type: "FactSet",
                          facts: [
                            { title: "Model", value: model },
                            { title: "Turns", value: String(info.turns) },
                            {
                              title: "Context",
                              value:
                                ctxMax > 0
                                  ? `${(ctxUsed / 1000).toFixed(0)}K / ${(ctxMax / 1000).toFixed(0)}K (${ctxPct}%)`
                                  : ctxUsed > 0
                                    ? `${(ctxUsed / 1000).toFixed(0)}K (awaiting SDK data)`
                                    : "—",
                            },
                            { title: "Cache", value: `${cacheHit}% hit` },
                            {
                              title: "Input",
                              value: `${u.totalInputTokens.toLocaleString()} tokens`,
                            },
                            {
                              title: "Output",
                              value: `${u.totalOutputTokens.toLocaleString()} tokens`,
                            },
                            {
                              title: "Avg response",
                              value:
                                avgMs > 0
                                  ? `${(avgMs / 1000).toFixed(1)}s`
                                  : "—",
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              };
              await proxyFetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(card),
                signal: AbortSignal.timeout(15_000),
              }).catch(() => {});
              continue;
            }
            if (trimmed === "/help") {
              const helpText =
                "**Commands:**\n- `/reset` — clear session & history\n- `/status` — session stats\n- `/help` — this message";
              const card = buildAdaptiveCard(helpText);
              await proxyFetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(card),
                signal: AbortSignal.timeout(15_000),
              }).catch(() => {});
              continue;
            }

            log(
              "teams",
              `[${msg.senderName}]: ${msg.text.slice(0, 80)}${msg.text.length > 80 ? "..." : ""}`,
            );

            execute({
              chatId: talonChatId,
              numericChatId,
              prompt: `[${msg.senderName}]: ${msg.text}`,
              senderName: msg.senderName,
              isGroup: true,
              source: "message",
              onStreamDelta: (_accumulated, phase) => {
                if (phase) log("teams", `  phase: ${phase}`);
              },
              onToolUse: (toolName, input) => {
                const detail = (input.description ??
                  input.command ??
                  input.action ??
                  input.query ??
                  input.url ??
                  input.name ??
                  "") as string;
                log(
                  "teams",
                  `  tool: ${toolName}${detail ? ` — ${String(detail).slice(0, 100)}` : ""}`,
                );
              },
            })
              .then(async (result) => {
                // Only deliver messages sent via the send_message tool.
                // Do NOT send fallback text — if Claude chose not to use send_message,
                // it's either choosing not to respond or outputting internal reasoning
                // that shouldn't be shown to users.
                if (result.bridgeMessageCount === 0 && result.text?.trim()) {
                  log(
                    "teams",
                    `Suppressed fallback text (${result.text.length} chars) — no send_message tool used`,
                  );
                }
              })
              .catch((err) => {
                logError(
                  "teams",
                  `execute failed: ${err instanceof Error ? err.message : err}`,
                );
              });
          }
        } catch (err) {
          logError(
            "teams",
            `Poll error: ${err instanceof Error ? err.message : err}`,
          );
        } finally {
          polling = false;
        }
      }

      // Initial poll, then interval
      await poll();
      pollTimer = setInterval(poll, pollIntervalMs);

      // Hold process open
      await new Promise(() => {});
    },

    async stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      await gateway.stop();
      log("teams", "Teams frontend stopped");
    },
  };
}
