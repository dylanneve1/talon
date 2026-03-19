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
import { classify } from "./errors.js";
import { getQueueSize } from "./dispatcher.js";
import { getHealthStatus } from "../util/watchdog.js";
import { getActiveSessionCount } from "../storage/sessions.js";
import { log, logError, logDebug } from "../util/log.js";
import { handleSharedAction } from "./gateway-actions.js";
import type { FrontendActionHandler } from "./types.js";

// ── State ───────────────────────────────────────────────────────────────────

let activeChatId: string | null = null;
let messagesSent = 0;
let locked = false;
let owner: string | null = null;
let refCount = 0;
const frontendHandlers = new Map<string, FrontendActionHandler>();
let server: ReturnType<typeof createServer> | null = null;
let activePort = 0;

// ── Frontend handler registration ───────────────────────────────────────────

/** Register a handler for a specific chatId prefix (e.g., "tg:", "teams:"). */
export function addFrontendHandler(prefix: string, handler: FrontendActionHandler): void {
  frontendHandlers.set(prefix, handler);
}

/** @deprecated Use addFrontendHandler with a prefix. Kept for backward compat. */
export function setFrontendHandler(handler: FrontendActionHandler): void {
  frontendHandlers.set("", handler); // catch-all
}

// ── Context management (same ref-counting as before) ────────────────────────

export function setGatewayContext(chatId: string): void {
  if (activeChatId === chatId) {
    refCount++;
    log("gateway", `Context ref++ for chat ${chatId} (refCount=${refCount})`);
    return;
  }
  activeChatId = chatId;
  messagesSent = 0;
  locked = true;
  owner = chatId;
  refCount = 1;
  log("gateway", `Context set for chat ${chatId}`);
}

export function clearGatewayContext(chatId?: string): void {
  if (chatId !== undefined && owner !== chatId) return;
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  log("gateway", `Context cleared for chat ${chatId ?? "?"}`);
  activeChatId = null;
  messagesSent = 0;
  locked = false;
  owner = null;
}

export function isGatewayBusy(): boolean { return locked; }
export function getGatewayMessageCount(): number { return messagesSent; }
export function incrementMessageCount(): void { messagesSent++; }
export function getGatewayPort(): number { return activePort; }
export function getGatewayChatId(): string | null { return activeChatId; }

// ── Retry helper ────────────────────────────────────────────────────────────

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classify(err);
      if (!classified.retryable) throw err;
      if (attempt < 2) {
        const delayMs = classified.retryAfterMs ?? 1000 * Math.pow(2, attempt);
        log("gateway", `Retry ${attempt + 1}/3 (${classified.reason}) after ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// ── Handler routing ──────────────────────────────────────────────────────────

function getHandlerForChat(chatId: string): FrontendActionHandler | null {
  // Try prefix-matched handlers first (e.g., "tg:", "teams:")
  for (const [prefix, handler] of frontendHandlers) {
    if (prefix && chatId.startsWith(prefix)) return handler;
  }
  // Fall back to catch-all (empty prefix) if registered
  return frontendHandlers.get("") ?? null;
}

// ── Action dispatch ─────────────────────────────────────────────────────────

async function handleAction(body: Record<string, unknown>): Promise<unknown> {
  const chatId = activeChatId;
  if (!chatId) {
    return { ok: false, error: "No active chat context" };
  }

  // Verify chatId matches (prevents cross-chat tool call routing)
  const requestChatId = body._chatId ? String(body._chatId) : null;
  if (requestChatId && requestChatId !== chatId) {
    logError("gateway", `Chat mismatch: request=${requestChatId} active=${chatId} action=${body.action}`);
    return { ok: false, error: "Chat context mismatch" };
  }

  const action = body.action as string;
  const t0 = Date.now();

  try {
    // Try shared actions first (cron, fetch_url, history)
    const shared = await handleSharedAction(body, chatId);
    if (shared) {
      logDebug("gateway", `${action} chat=${chatId} ${Date.now() - t0}ms (shared)`);
      return shared;
    }

    // Delegate to the matching frontend handler (by chatId prefix)
    const handler = getHandlerForChat(chatId);
    if (!handler) {
      return { ok: false, error: "No frontend handler registered" };
    }
    const result = await handler(body, chatId);
    if (result) {
      logDebug("gateway", `${action} chat=${chatId} ${Date.now() - t0}ms`);
      return result;
    }

    return { ok: false, error: `Unknown action: ${action}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("gateway", `${action} chat=${chatId} failed: ${msg}`);
    return { ok: false, error: `${action}: ${msg}` };
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

export function startGateway(port = 19876): Promise<number> {
  if (server) return Promise.resolve(activePort);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        const w = getHealthStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: w.healthy,
          uptime: Math.round(process.uptime()),
          memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          bridge: { active: locked, chatId: activeChatId },
          queue: getQueueSize(),
          sessions: getActiveSessionCount(),
          messages: w.totalMessagesProcessed,
          errors: w.recentErrorCount,
          lastActivity: w.msSinceLastMessage < 60000
            ? "just now"
            : `${Math.round(w.msSinceLastMessage / 60000)}m ago`,
        }));
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
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const result = await handleAction(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
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
        server = httpServer;
        activePort = p;
        log("gateway", `Action gateway on :${p}`);
        resolve(p);
      });
    };
    tryPort(port);
  });
}

export function stopGateway(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => { server = null; activePort = 0; resolve(); });
  });
}
