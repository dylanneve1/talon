/**
 * Bridge server — the HTTP + Server-Sent Events transport for the Talon
 * Client Bridge Protocol (see protocol.ts).
 *
 * Pure transport: it parses requests, enforces the optional bearer token,
 * fans SSE events out to every connected client, and delegates all logic to
 * the injected `BridgeServerHandlers`. No engine imports live here, so the
 * same server serves the Electron desktop app, a remote Android client, or a
 * curl one-liner identically.
 *
 * Binds `host` (loopback by default) with the gateway's EADDRINUSE +1..+5
 * fallback so two daemons on one machine don't collide.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { log, logError, logDebug } from "../../util/log.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEvent,
  type BridgeStatus,
  type ClientChat,
  type ClientMessage,
  type ModelOption,
} from "./protocol.js";
import type { ConfigSnapshot } from "./settings.js";

/** Everything the transport needs the frontend to implement. */
export type BridgeServerHandlers = {
  status(): BridgeStatus;
  listChats(): ClientChat[];
  createChat(title?: string): ClientChat;
  renameChat(id: string, title: string): ClientChat | null;
  deleteChat(id: string): boolean;
  history(id: string): ClientMessage[];
  /** Fire-and-forget: streams its results back through `broadcast`. */
  send(id: string, text: string): void;
  listModels(): { active: string; models: ModelOption[] };
  setModel(id: string, model: string): void;
  setEffort(id: string, effort: string): void;
  effortLevels(id: string): Promise<{ active: string; levels: string[] }>;
  resetChat(id: string): boolean;
  setPulse(id: string, on: boolean): void;
  /** Read the daemon's own (allowlisted) settings + health. */
  getConfig(): ConfigSnapshot;
  /** Change daemon settings; returns the fresh snapshot. */
  setConfig(update: Record<string, unknown>): ConfigSnapshot;
};

const SSE_PING_MS = 25_000;
const MAX_BODY_BYTES = 256 * 1024;
const PORT_FALLBACKS = 5;

export class BridgeServer {
  private server: Server | null = null;
  private clients = new Set<ServerResponse>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private port = 0;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      token?: string;
      startedAt: string;
    },
    private readonly handlers: BridgeServerHandlers,
  ) {}

  getPort(): number {
    return this.port;
  }

  /** Push an event to every connected SSE client. */
  broadcast(event: BridgeEvent): void {
    if (this.clients.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        // Write on a half-closed socket — the 'close' handler will evict it.
      }
    }
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        logError("native", "Bridge request handler threw", err);
        if (!res.headersSent) {
          res.writeHead(500, this.jsonHeaders());
          res.end(JSON.stringify({ ok: false, error: "Internal error" }));
        }
      });
    });

    this.pingTimer = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(": ping\n\n");
        } catch {
          /* evicted on close */
        }
      }
    }, SSE_PING_MS);
    this.pingTimer.unref?.();

    return new Promise<number>((resolve, reject) => {
      let attempt = 0;
      const tryPort = (p: number): void => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && attempt < PORT_FALLBACKS) {
            attempt++;
            server.removeAllListeners("error");
            server.removeAllListeners("listening");
            tryPort(p + 1);
          } else {
            reject(err);
          }
        });
        server.listen(p, this.opts.host, () => {
          this.server = server;
          const addr = server.address();
          this.port =
            typeof addr === "object" && addr !== null
              ? (addr as { port: number }).port
              : p;
          server.removeAllListeners("error");
          server.on("error", (err) =>
            logError("native", "Bridge server error", err),
          );
          log(
            "native",
            `Bridge listening on ${this.opts.host}:${this.port}` +
              (this.opts.token ? " (token required)" : ""),
          );
          resolve(this.port);
        });
      };
      tryPort(this.opts.port);
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.pingTimer);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        this.port = 0;
        resolve();
      });
    });
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://bridge");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, this.corsHeaders());
      res.end();
      return;
    }

    // /health is unauthenticated so clients can discover/ping the bridge
    // before they hold a token. It exposes no chat content.
    if (method === "GET" && path === "/health") {
      const s = this.handlers.status();
      return this.json(res, 200, {
        app: "talon-bridge",
        ok: true,
        protocol: BRIDGE_PROTOCOL_VERSION,
        host: this.opts.host,
        port: this.port,
        authRequired: Boolean(this.opts.token),
        startedAt: this.opts.startedAt,
        botName: s.botName,
        backend: s.backend,
        model: s.model,
        activeChats: s.activeChats,
      });
    }

    if (!this.authOk(req, url)) {
      return this.json(res, 401, { ok: false, error: "Unauthorized" });
    }

    try {
      if (method === "GET" && path === "/events") return this.openStream(res);

      if (method === "GET" && path === "/chats")
        return this.json(res, 200, { chats: this.handlers.listChats() });

      if (method === "POST" && path === "/chats") {
        const body = await this.readJson(req);
        const chat = this.handlers.createChat(asString(body.title));
        return this.json(res, 200, { chat });
      }

      if (method === "POST" && path === "/chats/rename") {
        const body = await this.readJson(req);
        const chat = this.handlers.renameChat(
          asString(body.chatId) ?? "",
          asString(body.title) ?? "",
        );
        return chat
          ? this.json(res, 200, { chat })
          : this.json(res, 404, { ok: false, error: "No such chat" });
      }

      if (method === "POST" && path === "/chats/delete") {
        const body = await this.readJson(req);
        const ok = this.handlers.deleteChat(asString(body.chatId) ?? "");
        return this.json(res, 200, { ok });
      }

      if (method === "POST" && path === "/chats/reset") {
        const body = await this.readJson(req);
        const ok = this.handlers.resetChat(asString(body.chatId) ?? "");
        return this.json(res, 200, { ok });
      }

      if (method === "POST" && path === "/chats/pulse") {
        const body = await this.readJson(req);
        this.handlers.setPulse(asString(body.chatId) ?? "", body.on === true);
        return this.json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/history") {
        const id = url.searchParams.get("chatId") ?? "";
        return this.json(res, 200, {
          chatId: id,
          messages: this.handlers.history(id),
        });
      }

      if (method === "POST" && path === "/send") {
        const body = await this.readJson(req);
        const id = asString(body.chatId) ?? "";
        const text = asString(body.text) ?? "";
        if (!id || !text.trim())
          return this.json(res, 400, {
            ok: false,
            error: "chatId and text required",
          });
        this.handlers.send(id, text);
        return this.json(res, 202, { ok: true });
      }

      if (method === "GET" && path === "/models")
        return this.json(res, 200, this.handlers.listModels());

      if (method === "POST" && path === "/model") {
        const body = await this.readJson(req);
        this.handlers.setModel(
          asString(body.chatId) ?? "",
          asString(body.model) ?? "",
        );
        return this.json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/effort") {
        const id = url.searchParams.get("chatId") ?? "";
        return this.json(res, 200, await this.handlers.effortLevels(id));
      }

      if (method === "POST" && path === "/effort") {
        const body = await this.readJson(req);
        this.handlers.setEffort(
          asString(body.chatId) ?? "",
          asString(body.effort) ?? "",
        );
        return this.json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/config")
        return this.json(res, 200, this.handlers.getConfig());

      if (method === "POST" && path === "/config") {
        const body = await this.readJson(req);
        return this.json(res, 200, this.handlers.setConfig(body));
      }

      return this.json(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.json(res, 400, { ok: false, error: msg });
    }
  }

  private openStream(res: ServerResponse): void {
    res.writeHead(200, {
      ...this.corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 3000\n\n`);
    // Opening snapshot so a freshly-connected client renders immediately.
    res.write(
      `data: ${JSON.stringify({
        kind: "hello",
        status: this.handlers.status(),
        chats: this.handlers.listChats(),
      })}\n\n`,
    );
    this.clients.add(res);
    logDebug("native", `SSE client connected (${this.clients.size} total)`);
    res.on("close", () => {
      this.clients.delete(res);
      logDebug("native", `SSE client left (${this.clients.size} total)`);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private authOk(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return true;
    const header = req.headers["authorization"];
    if (typeof header === "string" && header === `Bearer ${this.opts.token}`)
      return true;
    // EventSource can't set headers, so SSE clients pass ?token=… instead.
    return url.searchParams.get("token") === this.opts.token;
  }

  private corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }

  private jsonHeaders(): Record<string, string> {
    return { ...this.corsHeaders(), "Content-Type": "application/json" };
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, this.jsonHeaders());
    res.end(JSON.stringify(body));
  }

  private async readJson(
    req: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Body must be a JSON object");
    return parsed as Record<string, unknown>;
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
