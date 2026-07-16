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
import { classify } from "../errors.js";
import { getActiveCount } from "./dispatcher.js";
import { Loom, getActiveLoom, type ContextRegistry } from "../weaver/index.js";
import { getHealthStatus } from "../../util/watchdog.js";
import { getActiveSessionCount } from "../../storage/sessions.js";
import { log, logError, logDebug } from "../../util/log.js";
import { handleSharedAction } from "./gateway-actions/index.js";
import {
  handleHubRequest,
  getHubSessionCount,
  HUB_PATH_PREFIX,
} from "../mcp-hub/index.js";
import { handlePluginAction } from "../plugin/index.js";
import { bus } from "../bus/index.js";
import { taskTable } from "../tasks/index.js";
import type { FrontendActionHandler } from "../types.js";
import { BOT_MESSAGE_ACTIONS, noteBotMessage } from "../soul/taps.js";
import type { Backend } from "../agent-runtime/capabilities.js";
import {
  isNativeChatId,
  isDiscordChatId,
  isTelegramChatId,
  isTerminalChatId,
  isTeamsChatId,
} from "../../util/chat-id.js";

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
        const pRetryDelay = 1000 * Math.pow(2, attempt - 1);
        const delayMs = classified.retryAfterMs ?? pRetryDelay;
        log(
          "gateway",
          `Retry ${attempt}/3 (${classified.reason}) after ${delayMs}ms`,
        );
        if (classified.retryAfterMs && classified.retryAfterMs > pRetryDelay) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, classified.retryAfterMs! - pRetryDelay),
          );
        }
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
  /**
   * Per-chat live state is owned by the Weaver's Loom. The gateway holds no
   * registry of its own — it delegates here, and only through the
   * `ContextRegistry` face (the gateway never creates or evicts Threads).
   * `getActiveLoom()` returns the Weaver's Loom once the dispatcher is wired;
   * the standalone fallback covers unit tests and the brief startup window
   * before init (when no turn — and so no context — can exist anyway).
   */
  private readonly ownLoom = new Loom();
  private get loom(): ContextRegistry {
    return getActiveLoom() ?? this.ownLoom;
  }

  private frontendHandler: FrontendActionHandler | null = null;
  private readonly frontendHandlers = new Map<string, FrontendActionHandler>();
  private readonly chatFrontendOwners = new Map<number, string>();
  private server: ReturnType<typeof createServer> | null = null;
  private port = 0;
  private readonly startedAt = new Date().toISOString();
  private startedListeners: Array<(port: number) => void> = [];
  private shutdownHandler: ((reason: string) => void) | null = null;

  /**
   * Process role advertised on /health — lets the daemon CLI
   * (core/daemon/discovery.ts) tell the background daemon apart from a
   * `talon chat` session, which runs its own gateway on a nearby port.
   */
  constructor(readonly mode: "daemon" | "chat" = "chat") {}

  /**
   * Register a callback invoked once the HTTP server has bound. The
   * gateway may fall back from the requested port on EADDRINUSE, so
   * the actual port is only known here — the daemon uses this to
   * record the port in its pidfile.
   */
  onStarted(cb: (port: number) => void): void {
    if (this.server) cb(this.port);
    else this.startedListeners.push(cb);
  }

  /**
   * Register the graceful-shutdown trigger for POST /shutdown. Only
   * the daemon composition root registers one; without it the endpoint
   * answers 501.
   */
  onShutdownRequest(cb: (reason: string) => void): void {
    this.shutdownHandler = cb;
  }

  /**
   * The active backend — set initially by bootstrap and updated by
   * the backend controller on hot-swap (`switchBackend`). Reads route
   * through this field so command handlers, callbacks, and shared-
   * action dispatch all see the same instance the dispatcher does.
   */
  backend: Backend | null = null;

  // ── Frontend handler registration ────────────────────────────────────────

  setFrontendHandler(handler: FrontendActionHandler | null): void {
    this.frontendHandler = handler;
  }

  registerFrontendHandler(
    name: string,
    handler: FrontendActionHandler | null,
  ): void {
    if (handler === null) {
      this.frontendHandlers.delete(name);
      return;
    }
    this.frontendHandlers.set(name, handler);
  }

  private resolveOwnedFrontendName(
    rawChatId: string,
    chatId: number,
  ): string | null {
    const owned = this.chatFrontendOwners.get(chatId);
    if (owned) return owned;
    if (isTerminalChatId(rawChatId)) return "terminal";
    if (isNativeChatId(rawChatId)) return "native";
    if (isTeamsChatId(rawChatId)) return "teams";
    if (isDiscordChatId(rawChatId)) return "discord";
    if (isTelegramChatId(rawChatId)) return "telegram";
    return null;
  }

  private resolveFrontendHandler(
    rawChatId: string,
    chatId: number,
  ): FrontendActionHandler | null {
    const ownedName = this.resolveOwnedFrontendName(rawChatId, chatId);
    if (ownedName) {
      const ownedHandler = this.frontendHandlers.get(ownedName);
      if (ownedHandler) return ownedHandler;
    }
    if (this.frontendHandler) return this.frontendHandler;
    if (this.frontendHandlers.size === 1) {
      return this.frontendHandlers.values().next().value ?? null;
    }
    return null;
  }

  // ── Per-chat context management ──────────────────────────────────────────

  setContext(chatId: number, stringId?: string, frontendName?: string): void {
    this.loom.acquireContext(chatId, stringId);
    if (frontendName) this.chatFrontendOwners.set(chatId, frontendName);
    else if (stringId !== undefined && !this.chatFrontendOwners.has(chatId)) {
      const inferred = this.resolveOwnedFrontendName(stringId, chatId);
      if (inferred) this.chatFrontendOwners.set(chatId, inferred);
    }
  }

  /** Find a numeric chatId by its string ID (used for Teams-style non-numeric chat IDs). */
  private findContextByStringId(stringId: string): number | null {
    if (!stringId) return null;
    return this.loom.numericForStringId(stringId);
  }

  clearContext(chatId?: number | string): void {
    if (chatId === undefined) return;
    // The Loom resolves numeric ids, numeric-looking strings, and Teams-style
    // non-numeric ids (e.g. "19:abc...") to the right Thread itself.
    this.loom.releaseContext(chatId);
    if (typeof chatId === "number") {
      this.chatFrontendOwners.delete(chatId);
    } else {
      const numericId = Number(chatId);
      if (!Number.isNaN(numericId)) this.chatFrontendOwners.delete(numericId);
    }
  }

  isChatBusy(chatId: number): boolean {
    return this.loom.hasActiveContext(chatId);
  }

  getMessageCount(chatId: number): number {
    return this.loom.messageCount(chatId);
  }

  incrementMessages(chatId: number): void {
    this.loom.noteMessageSent(chatId);
  }

  getPort(): number {
    return this.port;
  }

  getActiveChats(): number {
    return this.loom.activeContextCount();
  }

  // ── Action dispatch ────────────────────────────────────────────────────────

  private async handleAction(body: Record<string, unknown>): Promise<unknown> {
    // Route by _chatId from the MCP subprocess request.
    // _chatId may be a string (Teams: "teams_chat_19:...") or numeric string
    // (Telegram: "123456"). The context map is keyed by numeric chatId, so
    // try direct parse first, then fall back to searching active contexts.
    //
    // For heartbeat-initiated outbound (no active chat session), the bridge
    // promotes the tool's explicit `chat_id` param into `_chatId` AND keeps
    // `chat_id` in the body as a signal that this is explicit-routing. When
    // `body.chat_id` is present and parses as numeric, we skip the
    // active-context-required check — the action handler will reach the
    // chat directly via the Telegram Bot API. The legacy context-required
    // path remains for chat-mode calls where `chat_id` is absent.
    const rawChatId = body._chatId ? String(body._chatId) : "";
    const numericId = Number(rawChatId);
    const explicitChatIdProvided = typeof body.chat_id !== "undefined";
    let chatId: number | null = null;
    if (
      explicitChatIdProvided &&
      !isNaN(numericId) &&
      rawChatId !== "" &&
      rawChatId !== "heartbeat"
    ) {
      // Explicit-routing branch: caller provided chat_id, trust it.
      chatId = numericId;
    } else if (
      rawChatId !== "" &&
      !isNaN(numericId) &&
      this.loom.hasActiveContext(numericId)
    ) {
      // Chat-mode branch: ambient _chatId must match an active context.
      chatId = numericId;
    } else {
      // String-id routing (Teams) — must match an active context.
      chatId = this.findContextByStringId(rawChatId);
    }
    if (chatId === null) {
      return { ok: false, error: "No active chat context" };
    }

    const action = typeof body.action === "string" ? body.action : "";
    if (!action) return { ok: false, error: "Missing action" };
    const t0 = Date.now();

    try {
      // Try frontend first — it has richer implementations (e.g. userbot history)
      // and falls back to null when it can't handle the action.
      const frontendHandler = this.resolveFrontendHandler(rawChatId, chatId);
      if (frontendHandler) {
        const result = await frontendHandler(body, chatId);
        if (result) {
          // Soul tap: remember our own outgoing message ids so a later
          // reaction update can be attributed to one of Talon's messages.
          // No-op unless the soul is enabled.
          if (BOT_MESSAGE_ACTIONS.has(action) && result.ok && result.message_id)
            noteBotMessage(chatId, Number(result.message_id));
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
      const shared = await handleSharedAction(body, chatId, this.backend);
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
              // Identity fields — daemon discovery matches on these to
              // distinguish a Talon daemon from chat sessions and
              // unrelated localhost services.
              app: "talon",
              mode: this.mode,
              pid: process.pid,
              port: this.port,
              startedAt: this.startedAt,
              ok: w.healthy,
              uptime: Math.round(process.uptime()),
              memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
              bridge: {
                activeChats: this.loom.activeContextCount(),
                threads: this.loom.size(),
                hubSessions: getHubSessionCount(),
              },
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

        if (req.method === "POST" && req.url === "/shutdown") {
          // Graceful stop for `talon stop`/`talon restart`. Bound to
          // 127.0.0.1 like everything else here. Respond before
          // triggering so the client isn't cut off mid-request; the
          // shutdown path takes seconds, so the reply flushes safely.
          if (!this.shutdownHandler) {
            res.writeHead(501, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: "Shutdown not supported by this process",
              }),
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          const handler = this.shutdownHandler;
          setImmediate(() => handler("gateway /shutdown"));
          return;
        }

        if (req.method === "GET" && req.url?.startsWith("/events/recent")) {
          // Bus tail — recent events, optionally after a cursor. Read by
          // `talon events`. Same 127.0.0.1 trust boundary as /action.
          const url = new URL(req.url, "http://gateway");
          const since = Number(url.searchParams.get("since") ?? "0");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              events: bus.recent(
                Number.isInteger(since) && since > 0 ? since : 0,
              ),
            }),
          );
          return;
        }

        if (
          req.method === "GET" &&
          (req.url?.startsWith("/vfs/list") || req.url?.startsWith("/vfs/read"))
        ) {
          // The talon:// namespace — the transport for `talon ls` /
          // `talon cat`, which need the daemon's live synthetic mounts
          // (proc, plugins). Same 127.0.0.1 trust boundary as /action.
          const url = new URL(req.url, "http://gateway");
          const path = url.searchParams.get("path") ?? "";
          const { getVfs } = await import("../vfs/index.js");
          const vfs = getVfs();
          let result: Record<string, unknown>;
          if (url.pathname === "/vfs/list") {
            const listed = vfs.list(path);
            result = listed.ok
              ? { ok: true, entries: listed.value }
              : { ok: false, error: listed.error, detail: listed.detail };
          } else {
            const content = vfs.read(path);
            result = content.ok
              ? { ok: true, content: content.value }
              : { ok: false, error: content.error, detail: content.detail };
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === "GET" && req.url === "/tasks") {
          // The task table — every live/recent unit of agent work. Read by
          // `talon ps`. Same 127.0.0.1 trust boundary as /action.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, tasks: taskTable.list() }));
          return;
        }

        if (req.method === "POST" && req.url === "/tasks/kill") {
          // Abort one killable task by id — the transport for `talon kill`.
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          let id: unknown;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            id = (body as { id?: unknown }).id;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
            return;
          }
          if (typeof id !== "number" || !Number.isInteger(id)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ ok: false, error: "id must be an integer" }),
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(taskTable.kill(id)));
          return;
        }

        if (req.method === "POST" && req.url === "/plugins/reload") {
          // Hot-reload plugins from config — the transport for
          // `talon plugin install/enable/disable`, which has no chat
          // context and so cannot use the reload_plugins action. Same
          // 127.0.0.1 trust boundary as /action.
          try {
            const { performPluginReload } =
              await import("./gateway-actions/plugins.js");
            const { names } = await performPluginReload(this.backend);
            log("gateway", `/plugins/reload: ${names.length} plugins loaded`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, loaded: names }));
          } catch (err) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                ok: false,
                error: `Plugin reload failed: ${err instanceof Error ? err.message : err}`,
              }),
            );
          }
          return;
        }

        if (req.url?.startsWith(HUB_PATH_PREFIX)) {
          // MCP hub — daemon-hosted MCP-over-HTTP endpoints for every
          // backend (see core/mcp-hub). Same 127.0.0.1 trust boundary
          // as /action.
          await handleHubRequest(req, res, `http://127.0.0.1:${this.port}`);
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
          // Log full error (incl. stack via logError's structured `stack`
          // field) on the server; return a generic message to the client so
          // we don't leak implementation details.
          // CodeQL: js/stack-trace-exposure (alert #4).
          logError(
            "gateway",
            `Unhandled error on ${req.method} ${req.url}`,
            err,
          );
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ ok: false, error: "Internal server error" }),
          );
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
            // The failed listen() left its one-shot 'listening' success
            // callback registered (Node attaches it via once('listening')).
            // Drop it before retrying — otherwise every stale callback also
            // fires when a later port finally binds, running the startup body
            // (and logging "Action gateway on :…") once per attempted port.
            httpServer.removeAllListeners("listening");
            tryPort(p + 1);
          } else {
            reject(err);
          }
        });
        httpServer.listen(p, "127.0.0.1", () => {
          this.server = httpServer;
          // When the caller asks for port 0 the OS assigns a random free
          // port — read the actual port off the listening socket instead
          // of saving the requested 0.
          const addr = httpServer.address();
          this.port =
            typeof addr === "object" && addr !== null
              ? (addr as { port: number }).port
              : p;
          log("gateway", `Action gateway on :${this.port}`);
          // Replace the one-shot startup error listener with a persistent
          // handler. Without this, once the `once("error")` from port-binding
          // fires (and auto-removes itself), any subsequent server-level error
          // has no listener and crashes the process via uncaught 'error' event.
          httpServer.removeAllListeners("error");
          httpServer.on("error", (err) =>
            logError("gateway", "HTTP server error", err),
          );
          for (const cb of this.startedListeners.splice(0)) {
            try {
              cb(this.port);
            } catch (err) {
              logError("gateway", "onStarted listener failed", err);
            }
          }
          resolve(this.port);
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
      // `close()` only stops NEW connections; MCP hub sessions hold
      // long-lived SSE streams that would keep the close callback from
      // ever firing. Terminate them — everything on this server is
      // localhost request/response or SSE, safe to drop at stop time.
      this.server.closeAllConnections();
    });
  }
}
