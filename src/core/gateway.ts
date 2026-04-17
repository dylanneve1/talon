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
import {
  log,
  logError,
  logDebug,
  setLogLevel,
  getLogLevel,
  type LogLevel,
} from "../util/log.js";
import { handleSharedAction } from "./gateway-actions.js";
import { handlePluginAction } from "./plugin.js";
import { withSpan } from "../util/trace.js";
import { buildDebugSnapshot } from "../util/debug.js";
import {
  incrementCounter,
  recordHistogram,
  sanitizeMetricLabel,
} from "../util/metrics.js";
import type { FrontendActionHandler, QueryBackend } from "./types.js";

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

  /** The active backend — set by bootstrap after initialization. */
  backend: QueryBackend | null = null;

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
    // Action names are bucketed for metric keys so untrusted/malformed input
    // can't blow out the global MAX_METRIC_KEYS cap. The raw action is still
    // logged and recorded as a span attribute for debugging.
    const mAction = sanitizeMetricLabel(action);
    const t0 = Date.now();

    return withSpan(
      "gateway.action",
      { action, chatId },
      async (span): Promise<unknown> => {
        try {
          // Try frontend first — it has richer implementations (e.g. userbot history)
          // and falls back to null when it can't handle the action.
          if (this.frontendHandler) {
            const result = await this.frontendHandler(body, chatId);
            if (result) {
              const ms = Date.now() - t0;
              span.setAttribute("route", "frontend");
              span.setAttribute("durationMs", ms);
              recordHistogram(`gateway.${mAction}.ms`, ms);
              incrementCounter(`gateway.${mAction}.ok`);
              logDebug("gateway", `${action} chat=${chatId} ${ms}ms`);
              return result;
            }
          }

          // Try plugin actions (loaded from external plugin packages)
          const pluginResult = await handlePluginAction(body, String(chatId));
          if (pluginResult) {
            const ms = Date.now() - t0;
            span.setAttribute("route", "plugin");
            span.setAttribute("durationMs", ms);
            recordHistogram(`gateway.${mAction}.ms`, ms);
            incrementCounter(`gateway.${mAction}.ok`);
            logDebug("gateway", `${action} chat=${chatId} ${ms}ms (plugin)`);
            return pluginResult;
          }

          // Shared actions last — provides in-memory fallbacks for history, cron, etc.
          const shared = await handleSharedAction(body, chatId, this.backend);
          if (shared) {
            const ms = Date.now() - t0;
            span.setAttribute("route", "shared");
            span.setAttribute("durationMs", ms);
            recordHistogram(`gateway.${mAction}.ms`, ms);
            incrementCounter(`gateway.${mAction}.ok`);
            logDebug("gateway", `${action} chat=${chatId} ${ms}ms (shared)`);
            return shared;
          }

          incrementCounter(`gateway.${mAction}.unknown`);
          span.setStatus("error", `Unknown action: ${action}`);
          return { ok: false, error: `Unknown action: ${action}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          incrementCounter(`gateway.${mAction}.error`);
          span.setStatus("error", err);
          logError("gateway", `${action} chat=${chatId} failed: ${msg}`);
          return { ok: false, error: `${action}: ${msg}` };
        }
      },
    );
  }

  // ── Debug endpoints ──────────────────────────────────────────────────────

  private async handleDebug(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname;
    const writeJson = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    // Clamp query-parsed limits to positive finite integers so malformed or
    // absurdly large values can't return the whole in-memory buffer or allocate
    // unbounded response arrays.
    const parseLimit = (
      raw: string | null,
      def: number,
      max = 1000,
    ): number => {
      if (raw === null) return def;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return def;
      return Math.min(Math.floor(n), max);
    };

    try {
      const { getMetrics } = await import("../util/metrics.js");
      const { getRecentSpans } = await import("../util/trace.js");
      const { getRecentLogs } = await import("../util/log.js");
      const { getRecentErrors } = await import("../util/watchdog.js");

      if (route === "/debug/state") {
        writeJson(200, buildDebugSnapshot());
        return;
      }
      if (route === "/debug/metrics") {
        writeJson(200, getMetrics());
        return;
      }
      if (route === "/debug/spans") {
        const limit = parseLimit(url.searchParams.get("limit"), 100);
        writeJson(200, { spans: getRecentSpans(limit) });
        return;
      }
      if (route === "/debug/logs") {
        const limit = parseLimit(url.searchParams.get("limit"), 100);
        const levelRaw = url.searchParams.get("level");
        const ALLOWED: LogLevel[] = [
          "trace",
          "debug",
          "info",
          "warn",
          "error",
          "fatal",
          "silent",
        ];
        if (levelRaw !== null && !ALLOWED.includes(levelRaw as LogLevel)) {
          writeJson(400, {
            ok: false,
            error: `Invalid level. Allowed: ${ALLOWED.join(", ")}`,
          });
          return;
        }
        const level = levelRaw as LogLevel | null;
        writeJson(200, {
          level: getLogLevel(),
          logs: getRecentLogs(limit, level ?? undefined),
        });
        return;
      }
      if (route === "/debug/errors") {
        const limit = parseLimit(url.searchParams.get("limit"), 20);
        writeJson(200, { errors: getRecentErrors(limit) });
        return;
      }
      if (route === "/debug/log-level") {
        writeJson(200, { level: getLogLevel() });
        return;
      }
      writeJson(404, { ok: false, error: "Unknown debug route" });
    } catch (err) {
      logError("gateway", `Debug endpoint ${route} failed`, err);
      writeJson(500, { ok: false, error: "Internal error" });
    }
  }

  private async handleSetLogLevel(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        level?: LogLevel;
      };
      if (!body.level) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Missing level" }));
        return;
      }
      setLogLevel(body.level);
      log("gateway", `Log level changed to ${body.level}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, level: body.level }));
    } catch (err) {
      logError("gateway", "Set log level failed", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid request" }));
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

        if (req.method === "GET" && req.url?.startsWith("/debug/")) {
          await this.handleDebug(req, res);
          return;
        }

        if (req.method === "POST" && req.url === "/debug/log-level") {
          await this.handleSetLogLevel(req, res);
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
