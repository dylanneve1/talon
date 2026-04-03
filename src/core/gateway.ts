/**
 * Gateway — generic HTTP bridge between MCP tool subprocess and the active frontend.
 *
 * The MCP subprocess (tools.ts) calls POST /action with action bodies.
 * The gateway tries shared actions first (cron, fetch_url, history),
 * then delegates to the active frontend's action handler.
 *
 * No platform-specific imports — frontends register their handler at startup.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import pRetry, { AbortError } from "p-retry";
import { classify } from "./errors.js";
import { getActiveCount } from "./dispatcher.js";
import { getHealthStatus } from "../util/watchdog.js";
import { getActiveSessionCount } from "../storage/sessions.js";
import { log, logError, logDebug } from "../util/log.js";
import { handleSharedAction } from "./gateway-actions.js";
import { handlePluginAction } from "./plugin.js";
import type { FrontendActionHandler } from "./types.js";

// ── Per-chat context state ───────────────────────────────────────────────────

type ChatContext = {
  refCount: number;
  messagesSent: number;
  stringId?: string;
};

// ── Retry helper (stateless — standalone export) ─────────────────────────────

/**
 * Retry a function up to 3 times with classified error inspection.
 * Non-retryable errors (auth, bad_request, context_length) are thrown immediately.
 * Uses p-retry for proper exponential backoff with jitter.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  return pRetry(
    async (attempt) => {
      try {
        return await fn();
      } catch (err) {
        const classified = classify(err);
        if (!classified.retryable) {
          // Wrap in AbortError to prevent further retries
          throw new AbortError(classified);
        }
        const delayMs =
          classified.retryAfterMs ?? 1000 * Math.pow(2, attempt - 1);
        log(
          "gateway",
          `Retry ${attempt}/3 (${classified.reason}) after ${delayMs}ms`,
        );
        throw classified; // rethrow to trigger p-retry delay
      }
    },
    {
      retries: 2, // 3 total attempts
      minTimeout: 1000,
      maxTimeout: 60_000,
      factor: 2,
      onFailedAttempt: (err) => {
        if (err.retriesLeft === 0) {
          logError("gateway", `All retries exhausted: ${err.error.message}`);
        }
      },
    },
  );
}

// ── Gateway class ────────────────────────────────────────────────────────────

export class Gateway {
  private chatContexts = new Map<number, ChatContext>();
  private frontendHandler: FrontendActionHandler | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;

  // ── Frontend handler registration ────────────────────────────────────────

  setFrontendHandler(handler: FrontendActionHandler | null): void {
    this.frontendHandler = handler;
  }

  // ── Per-chat context management ──────────────────────────────────────────

  setContext(chatId: number, stringId?: string): void {
    const ctx = this.chatContexts.get(chatId);
    if (ctx) {
      ctx.refCount++;
      log(
        "gateway",
        `Context ref++ for chat ${chatId} (refCount=${ctx.refCount})`,
      );
    } else {
      this.chatContexts.set(chatId, { refCount: 1, messagesSent: 0, stringId });
      log(
        "gateway",
        `Context acquired for chat ${chatId}${stringId ? ` (${stringId})` : ""}`,
      );
    }
  }

  /** Find a numeric chatId by its string ID (used for Teams-style non-numeric chat IDs). */
  private findContextByStringId(stringId: string): number | null {
    if (!stringId) return null;
    for (const [numId, ctx] of this.chatContexts) {
      if (ctx.stringId === stringId) return numId;
    }
    return null;
  }

  clearContext(chatId?: number | string): void {
    if (chatId === undefined) return;
    const parsed = typeof chatId === "number" ? chatId : Number(chatId);
    // For non-numeric IDs (e.g. Teams "19:abc..."), Number() returns NaN — look up by string
    const numId = !isNaN(parsed)
      ? parsed
      : this.findContextByStringId(String(chatId));
    if (numId === null) return;
    const ctx = this.chatContexts.get(numId);
    if (!ctx) return;
    ctx.refCount = Math.max(0, ctx.refCount - 1);
    if (ctx.refCount <= 0) {
      this.chatContexts.delete(numId);
      log("gateway", `Context released for chat ${numId}`);
    }
  }

  isChatBusy(chatId: number): boolean {
    return this.chatContexts.has(chatId);
  }

  getMessageCount(chatId: number): number {
    return this.chatContexts.get(chatId)?.messagesSent ?? 0;
  }

  incrementMessages(chatId: number): void {
    const ctx = this.chatContexts.get(chatId);
    if (ctx) ctx.messagesSent++;
  }

  getPort(): number {
    return this.port;
  }

  getActiveChats(): number {
    return this.chatContexts.size;
  }

  // ── Action dispatch ────────────────────────────────────────────────────────

  private async handleAction(body: Record<string, unknown>): Promise<unknown> {
    // Route by _chatId from the MCP subprocess request.
    // _chatId may be a string (Teams: "teams_chat_19:...") or numeric string (Telegram: "123456").
    // The context map is keyed by numeric chatId, so try direct parse first,
    // then fall back to searching active contexts.
    const rawChatId = body._chatId ? String(body._chatId) : "";
    const numericId = Number(rawChatId);
    const chatId =
      !isNaN(numericId) && this.chatContexts.has(numericId)
        ? numericId
        : this.findContextByStringId(rawChatId);
    if (!chatId) {
      return { ok: false, error: "No active chat context" };
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (!action) return { ok: false, error: "Missing action" };
    const t0 = Date.now();

    try {
      // Try frontend first — it has richer implementations (e.g. userbot history)
      // and falls back to null when it can't handle the action.
      if (this.frontendHandler) {
        const result = await this.frontendHandler(body, chatId);
        if (result) {
          logDebug("gateway", `${action} chat=${chatId} ${Date.now() - t0}ms`);
          return result;
        }
      }

      // Try plugin actions (loaded from external plugin packages)
      const pluginResult = await handlePluginAction(body, String(chatId));
      if (pluginResult) {
        logDebug(
          "gateway",
          `${action} chat=${chatId} ${Date.now() - t0}ms (plugin)`,
        );
        return pluginResult;
      }

      // Shared actions last — provides in-memory fallbacks for history, cron, etc.
      const shared = await handleSharedAction(body, chatId);
      if (shared) {
        logDebug(
          "gateway",
          `${action} chat=${chatId} ${Date.now() - t0}ms (shared)`,
        );
        return shared;
      }

      return { ok: false, error: `Unknown action: ${action}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError("gateway", `${action} chat=${chatId} failed: ${msg}`);
      return { ok: false, error: `${action}: ${msg}` };
    }
  }

  // ── HTTP server ──────────────────────────────────────────────────────────

  async start(port = 19876): Promise<number> {
    if (this.server) return this.port;

    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "GET" && req.url === "/health") {
          const w = getHealthStatus();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: w.healthy,
              uptime: Math.round(process.uptime()),
              memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              bridge: { activeChats: this.chatContexts.size },
              queue: getActiveCount(),
              sessions: getActiveSessionCount(),
              messages: w.totalMessagesProcessed,
              errors: w.recentErrorCount,
              lastActivity:
                w.msSinceLastMessage < 60000
                  ? "just now"
                  : `${Math.round(w.msSinceLastMessage / 60000)}m ago`,
            }),
          );
          return;
        }

        if (req.method !== "POST" || req.url !== "/action") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
            return;
          }
          const result = await this.handleAction(body);
          const json = JSON.stringify(result);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(json);
        } catch (err) {
          if (res.headersSent) return;
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: msg }));
        }
      },
    );

    return new Promise<number>((resolve, reject) => {
      let attempt = 0;
      const tryPort = (p: number) => {
        httpServer.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < 5) {
            attempt++;
            httpServer.removeAllListeners("error");
            tryPort(p + 1);
          } else {
            reject(err);
          }
        });
        httpServer.listen(p, "127.0.0.1", () => {
          this.server = httpServer;
          this.port = p;
          log("gateway", `Action gateway on :${p}`);
          resolve(p);
        });
      };
      tryPort(port);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }
}
