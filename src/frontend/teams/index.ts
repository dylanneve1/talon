/**
 * Teams frontend — bidirectional messaging via Power Automate webhooks.
 *
 * SEND (Talon → Teams):  POST Adaptive Cards to a Power Automate workflow webhook URL.
 * RECEIVE (Teams → Talon): HTTP server receives POSTs from a Power Automate flow
 *                          triggered by "When a new channel message is added".
 *
 * No Azure AD, no Bot Framework — just webhooks.
 */

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/gateway.js";
import { log, logError, logWarn } from "../../util/log.js";
import { createTeamsActionHandler, postToTeams } from "./actions.js";
import { stripHtml, splitTeamsMessage, buildAdaptiveCard } from "./formatting.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Payload shape from the Power Automate flow. */
type InboundMessage = {
  text?: string;
  htmlContent?: string;
  senderName?: string;
  channelId?: string;
  teamId?: string;
  messageId?: string;
};

export type TeamsFrontend = {
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a stable 32-bit numeric chat ID from team + channel identifiers.
 * This gives each Teams channel a unique ID for the gateway context system.
 */
function deriveNumericChatId(teamId: string, channelId: string): number {
  const hash = createHash("sha256").update(`${teamId}_${channelId}`).digest();
  // Use unsigned 32-bit int, ensure positive
  return hash.readUInt32BE(0);
}

/** Read the full request body as a string. */
function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── Frontend factory ─────────────────────────────────────────────────────────

export function createTeamsFrontend(
  config: TalonConfig,
  gateway: Gateway,
): TeamsFrontend {
  const webhookUrl = (config as Record<string, unknown>).teamsWebhookUrl as string;
  const webhookSecret = (config as Record<string, unknown>).teamsWebhookSecret as string | undefined;
  const webhookPort = ((config as Record<string, unknown>).teamsWebhookPort as number) || 19878;
  const botDisplayName = ((config as Record<string, unknown>).teamsBotDisplayName as string) || "";

  let webhookServer: Server | null = null;

  const context: ContextManager = {
    acquire: (chatId: number) => gateway.setContext(chatId),
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
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(card),
            signal: AbortSignal.timeout(15_000),
          });
        }
      } catch (err) {
        logError("teams", `sendMessage failed: ${err instanceof Error ? err.message : err}`);
      }
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      // Register action handler with the gateway
      gateway.setFrontendHandler(createTeamsActionHandler(webhookUrl, gateway));
      const port = await gateway.start(19876);
      log("teams", `Gateway on port ${port}`);

      // Start the inbound webhook server
      const { execute } = await import("../../core/dispatcher.js");

      webhookServer = createServer(async (req, res) => {
        // Health check
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, frontend: "teams" }));
          return;
        }

        // Only accept POST to /teams-webhook
        if (req.method !== "POST" || req.url !== "/teams-webhook") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        // Respond immediately — Power Automate has short timeouts
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));

        try {
          const rawBody = await readBody(req);

          // Verify shared secret if configured
          if (webhookSecret) {
            const headerSecret = req.headers["x-webhook-secret"] as string | undefined;
            if (headerSecret !== webhookSecret) {
              logWarn("teams", "Rejected webhook: invalid secret");
              return;
            }
          }

          let msg: InboundMessage;
          try {
            msg = JSON.parse(rawBody);
          } catch {
            logWarn("teams", "Rejected webhook: invalid JSON");
            return;
          }

          // Extract message text
          let text = msg.text?.trim() || "";
          if (!text && msg.htmlContent) {
            text = stripHtml(msg.htmlContent);
          }
          if (!text) {
            log("teams", "Skipped empty message");
            return;
          }

          const senderName = msg.senderName || "Unknown";

          // Skip messages from the bot itself to prevent echo loops
          if (botDisplayName && senderName.toLowerCase() === botDisplayName.toLowerCase()) {
            log("teams", "Skipped own message (echo loop prevention)");
            return;
          }

          const teamId = msg.teamId || "default";
          const channelId = msg.channelId || "default";
          const numericChatId = deriveNumericChatId(teamId, channelId);
          const chatId = `teams_${teamId}_${channelId}`;

          log("teams", `Message from ${senderName} in ${chatId}: ${text.slice(0, 80)}...`);

          // Execute the query asynchronously
          execute({
            chatId,
            numericChatId,
            prompt: `[${senderName}]: ${text}`,
            senderName,
            isGroup: true,
            messageId: msg.messageId ? Number(msg.messageId) : undefined,
            source: "message",
          }).catch((err) => {
            logError("teams", `execute failed: ${err instanceof Error ? err.message : err}`);
          });
        } catch (err) {
          logError("teams", `Webhook handler error: ${err instanceof Error ? err.message : err}`);
        }
      });

      await new Promise<void>((resolve, reject) => {
        webhookServer!.once("error", reject);
        webhookServer!.listen(webhookPort, "0.0.0.0", () => {
          log("teams", `Webhook receiver on 0.0.0.0:${webhookPort}`);
          resolve();
        });
      });
    },

    async start() {
      log("teams", "Teams frontend running");
      log("teams", `Send webhook: ${webhookUrl.slice(0, 60)}...`);
      log("teams", `Receive endpoint: POST http://0.0.0.0:${webhookPort}/teams-webhook`);

      // Hold process open
      await new Promise(() => {});
    },

    async stop() {
      if (webhookServer) {
        await new Promise<void>((resolve) => {
          webhookServer!.close(() => resolve());
        });
        webhookServer = null;
      }
      await gateway.stop();
      log("teams", "Teams frontend stopped");
    },
  };
}
