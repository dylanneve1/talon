/**
 * Teams frontend factory.
 *
 * Encapsulates everything Teams-specific: BotFrameworkAdapter, Express server,
 * activity handler, graceful shutdown. Registers its action handler with the
 * core gateway so MCP tool calls route to Teams API.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  BotFrameworkAdapter,
  TurnContext,
  MessageFactory,
} from "botbuilder";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import {
  startGateway,
  stopGateway,
  setGatewayContext,
  clearGatewayContext,
  isGatewayBusy,
  getGatewayMessageCount,
  getGatewayPort,
  setFrontendHandler,
} from "../../core/gateway.js";
import { createTeamsActionHandler } from "./actions.js";
import { createTeamsActivityHandler } from "./handlers.js";
import {
  initConversationStore,
  getConversationReference,
  flushConversationStore,
} from "./conversation-store.js";
import { log, logError } from "../../util/log.js";

// ── Frontend interface ──────────────────────────────────────────────────────

export type TeamsFrontend = {
  context: ContextManager;
  sendTyping: (chatId: string) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

// ── Factory ─────────────────────────────────────────────────────────────────

export function createTeamsFrontend(config: TalonConfig): TeamsFrontend {
  const teamsConfig = config.teams;
  if (!teamsConfig) throw new Error("Teams config missing — set teams.clientId, teams.clientSecret, teams.tenantId");

  const adapter = new BotFrameworkAdapter({
    appId: teamsConfig.clientId,
    appPassword: teamsConfig.clientSecret,
    channelAuthTenant: teamsConfig.tenantId,
  });

  adapter.onTurnError = async (context, error) => {
    logError("teams", `Turn error: ${error instanceof Error ? error.message : error}`);
    try {
      await context.sendActivity("Sorry, something went wrong. Please try again.");
    } catch { /* can't send error */ }
  };

  const activityHandler = createTeamsActivityHandler(config);
  let httpServer: Server | null = null;

  const context: ContextManager = {
    acquire: (chatId: string) => setGatewayContext(chatId),
    release: (chatId: string) => clearGatewayContext(chatId),
    isBusy: () => isGatewayBusy(),
    getMessageCount: () => getGatewayMessageCount(),
  };

  return {
    context,

    sendTyping: async (chatId: string) => {
      const convId = chatId.replace(/^teams:/, "");
      const ref = getConversationReference(convId);
      if (!ref) return;
      try {
        await adapter.continueConversation(ref, async (ctx) => {
          await ctx.sendActivity({ type: "typing" });
        });
      } catch { /* typing indicator failed — non-critical */ }
    },

    sendMessage: async (chatId: string, text: string) => {
      const convId = chatId.replace(/^teams:/, "");
      const ref = getConversationReference(convId);
      if (!ref) {
        logError("teams", `No conversation reference for chat ${chatId}`);
        return;
      }
      await adapter.continueConversation(ref, async (ctx) => {
        await ctx.sendActivity(MessageFactory.text(text));
      });
    },

    getBridgePort: () => getGatewayPort(),

    async init() {
      // Initialize conversation store
      initConversationStore(config.workspace);

      // Register Teams action handler with the core gateway
      setFrontendHandler(createTeamsActionHandler(adapter));

      const port = await startGateway(19876);
      log("teams", `Gateway started on port ${port}`);
    },

    async start() {
      const teamsPort = teamsConfig.port ?? 3978;

      // Create HTTP server for Teams webhook
      // BotFrameworkAdapter.process accepts Node.js req/res (typed as Express)
      httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "POST" && req.url === "/api/messages") {
          try {
            await (adapter as any).process(req, res, (context: TurnContext) =>
              activityHandler.run(context),
            );
          } catch (err) {
            logError("teams", `Process error: ${err instanceof Error ? err.message : err}`);
            if (!res.headersSent) {
              res.writeHead(500);
              res.end("Internal Server Error");
            }
          }
        } else if (req.method === "GET" && req.url === "/") {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Talon Teams Bot is running");
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
      });

      await new Promise<void>((resolve, reject) => {
        httpServer!.listen(teamsPort, () => {
          log("teams", `Talon running on Teams — listening on :${teamsPort}/api/messages`);
          resolve();
        });
        httpServer!.once("error", reject);
      });

      // Keep process alive
      await new Promise(() => {});
    },

    async stop() {
      flushConversationStore();
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => {
            log("shutdown", "Teams HTTP server closed");
            resolve();
          });
        });
        httpServer = null;
      }
      await stopGateway();
      log("shutdown", "Teams frontend stopped");
    },
  };
}
