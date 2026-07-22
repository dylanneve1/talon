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
 * fallback so two daemons on one machine don't collide. With a TLS identity
 * injected (see tls.ts) the same server speaks HTTPS instead — clients pin
 * the certificate fingerprint surfaced on `/health`.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { log, logError, logDebug, logWarn } from "../../util/log.js";
import { formatFingerprint, type BridgeTlsIdentity } from "./tls.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  isLogLevel,
  type BackendOption,
  type BridgeEvent,
  type BridgeStatus,
  type ClientChat,
  type ClientMessage,
  type DeviceInfo,
  type DeviceLocation,
  type LogEntry,
  type LogLevel,
  type ModelOption,
  type PluginItem,
  type SearchResult,
  type SkillItem,
  type ToggleResult,
} from "./protocol.js";
import type { ConfigSnapshot } from "./settings.js";

/** Optional attachment references carried alongside a sent message. */
export type SendOptions = {
  /** Relative bridge path to render inline (e.g. `/media?id=…`). */
  imagePath?: string;
  /** Absolute on-disk path handed to the model so it can read the file. */
  attachmentPath?: string;
};

/** Everything the transport needs the frontend to implement. */
export type BridgeServerHandlers = {
  status(): BridgeStatus;
  listChats(): ClientChat[];
  createChat(title?: string): ClientChat;
  renameChat(id: string, title: string): ClientChat | null;
  deleteChat(id: string): boolean;
  /** A page of history: newest window, or the window before `before`. */
  history(
    id: string,
    opts?: { before?: number; limit?: number },
  ): ClientMessage[];
  /** Full-text search across chats (or one chat when `chatId` is given). */
  search(query: string, chatId?: string): SearchResult[];
  /** Fire-and-forget: streams its results back through `broadcast`. */
  send(id: string, text: string, opts?: SendOptions): void;
  /** Persist an uploaded image and return its render path + on-disk path. */
  upload(
    filename: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<{ imagePath: string; path: string }>;
  listModels(
    id?: string,
  ):
    | { active: string; models: ModelOption[] }
    | Promise<{ active: string; models: ModelOption[] }>;
  setModel(id: string, model: string): void;
  /** Backends selectable for a chat + the chat's active backend id. */
  listBackends(id: string): { active: string; backends: BackendOption[] };
  /** Switch a chat to another backend; returns ok + an optional error. */
  setBackend(
    id: string,
    backend: string,
  ): Promise<{ ok: boolean; error?: string }>;
  setEffort(id: string, effort: string): void;
  effortLevels(id: string): Promise<{ active: string; levels: string[] }>;
  resetChat(id: string): boolean;
  /** Best-effort interrupt of a chat's in-flight turn. `true` if one was
   *  running and got signalled. */
  interruptTurn(id: string): Promise<boolean>;
  setPulse(id: string, on: boolean): void;
  /** Set/replace/clear the chat's queued follow-up (empty text clears). */
  queueMessage(id: string, text: string): void;
  /** Read the daemon's own (allowlisted) settings + health. */
  getConfig(): ConfigSnapshot;
  /** Change daemon settings; returns the fresh snapshot. */
  setConfig(update: Record<string, unknown>): ConfigSnapshot;
  /** Installed plugins (built-ins + configured entries) with state. */
  listPlugins(): PluginItem[];
  /** Enable/disable a plugin; persists + hot-reloads. */
  setPluginEnabled(name: string, enabled: boolean): Promise<ToggleResult>;
  /** Installed skills with state. */
  listSkills(): SkillItem[];
  /** Enable/disable a skill; rebuilds the prompt index. */
  setSkillEnabled(name: string, enabled: boolean): ToggleResult;
  /** Fire a daemon-level control action (e.g. "restart", "dream"). */
  control(action: string): Promise<{ ok: boolean; message: string }>;
  /** Newest daemon log entries (for the client's log viewer). */
  logs(opts: {
    lines: number;
    minLevel?: LogLevel;
    component?: string;
  }): LogEntry[];
  /** Events reconstructing any in-progress turns, for a just-connected client. */
  liveTurnEvents(): BridgeEvent[];
  /** Resolve a media id to an absolute file path (or null if unknown). */
  mediaPath(id: string): string | null;
  /** Register/update one mesh device. */
  registerDevice(body: Record<string, unknown>): Promise<DeviceInfo>;
  /** Store the last-known location for one mesh device. */
  storeLocation(body: Record<string, unknown>): Promise<DeviceLocation>;
  /** List mesh devices and their last-known locations. */
  listDevices():
    | { devices: DeviceInfo[]; locations: DeviceLocation[] }
    | Promise<{ devices: DeviceInfo[]; locations: DeviceLocation[] }>;
  /** A device answered a device_command; true when a call was waiting. */
  completeCommand(body: Record<string, unknown>): boolean;
  /** A device streams a pull-transfer's file body up (raw request body). */
  acceptFileUpload(
    token: string,
    body: IncomingMessage,
  ): Promise<{ ok: true; bytes: number } | { ok: false; error: string }>;
  /** Resolve a push-transfer token to the file to stream down, or null. */
  openFileDownload(
    token: string,
  ): Promise<{ path: string; size: number } | null>;
  /** Resolve a node-provisioning token to its installer script, or null. */
  openNodeInstall(token: string): { script: string; filename: string } | null;
  /** Resolve a node-provisioning token to the binary to stream, or null. */
  openNodeBinary(token: string): { path: string; size: number } | null;
};

const SSE_PING_MS = 25_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const PORT_FALLBACKS = 5;

// Failed-auth lockout: after this many wrong tokens from one address inside
// the window, that address gets 429s until the window lapses. The token's
// 256 bits make brute force hopeless anyway — this is about not letting an
// internet-facing bridge be hammered for free (and giving fail2ban-style
// tooling a clean signal in the log). Only *presented-and-wrong* secrets
// count: tokenless probes are just scanners finding a locked door.
const AUTH_LOCKOUT_MAX_FAILURES = 20;
const AUTH_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
/** Hard cap on tracked addresses so the map can't become a memory lever. */
const AUTH_LOCKOUT_MAX_TRACKED = 10_000;

/**
 * ok: request carries the right token (or none is required).
 * anonymous: no credential presented — a pre-pairing probe, not an attack.
 * bad: a credential was presented and it is wrong.
 */
type AuthState = "ok" | "anonymous" | "bad";

export class BridgeServer {
  private server: Server | null = null;
  private clients = new Set<ServerResponse>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private port = 0;
  private tlsIdentity: BridgeTlsIdentity | null = null;
  /** Wrong-token counts per remote address (behind a proxy: per proxy). */
  private authFailures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      token?: string;
      startedAt: string;
      /**
       * When present, the bridge serves HTTPS with this identity. A provider
       * (not the identity itself) so the transport stays free of key-file
       * I/O — it resolves once, inside `start()`.
       */
      tls?: () => Promise<BridgeTlsIdentity>;
    },
    private readonly handlers: BridgeServerHandlers,
  ) {}

  getPort(): number {
    return this.port;
  }

  /** "https" once started with a TLS identity, else "http". */
  getScheme(): "http" | "https" {
    return this.tlsIdentity ? "https" : "http";
  }

  /** The served certificate's SHA-256 fingerprint (hex), or null over HTTP. */
  getFingerprint(): string | null {
    return this.tlsIdentity?.fingerprint ?? null;
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
    this.tlsIdentity = this.opts.tls ? await this.opts.tls() : null;
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      this.handle(req, res).catch((err) => {
        logError("native", "Bridge request handler threw", err);
        if (!res.headersSent) {
          res.writeHead(500, this.jsonHeaders());
          res.end(JSON.stringify({ ok: false, error: "Internal error" }));
        }
      });
    };
    // https.Server extends http.Server's request/lifecycle surface — one
    // `Server`-typed field serves both transports.
    const server: Server = this.tlsIdentity
      ? createTlsServer(
          { key: this.tlsIdentity.keyPem, cert: this.tlsIdentity.certPem },
          onRequest,
        )
      : createServer(onRequest);

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
            `Bridge listening on ${this.getScheme()}://${this.opts.host}:${this.port}` +
              (this.opts.token ? " (token required)" : ""),
          );
          if (this.tlsIdentity) {
            // The pairing datum: clients confirm this fingerprint on first
            // connect, so it belongs in the log where the operator looks.
            log(
              "native",
              `Bridge certificate fingerprint ${formatFingerprint(this.tlsIdentity.fingerprint)}`,
            );
          }
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

    const remote = req.socket.remoteAddress ?? "unknown";
    if (this.authLockedOut(remote)) {
      res.writeHead(429, {
        ...this.jsonHeaders(),
        "Retry-After": String(Math.ceil(AUTH_LOCKOUT_WINDOW_MS / 1000)),
      });
      res.end(
        JSON.stringify({ ok: false, error: "Too many failed auth attempts" }),
      );
      return;
    }

    const auth = this.authState(req, url);
    if (auth === "bad") this.recordAuthFailure(remote);
    else if (auth === "ok") this.authFailures.delete(remote);

    // /health is unauthenticated so clients can discover/ping the bridge
    // before they hold a token. Pre-auth it serves only what pairing needs
    // (identity, protocol, fingerprint) — operational details like bot name,
    // backend, and chat count are not for internet scanners to enumerate.
    if (method === "GET" && path === "/health") {
      const base = {
        app: "talon-bridge",
        ok: true,
        protocol: BRIDGE_PROTOCOL_VERSION,
        port: this.port,
        scheme: this.getScheme(),
        // The certificate's own hash — public by definition (any TLS client
        // sees the certificate), surfaced so pairing UIs can display it.
        fingerprint: this.getFingerprint(),
        authRequired: Boolean(this.opts.token),
      };
      if (auth !== "ok") return this.json(res, 200, base);
      const s = this.handlers.status();
      return this.json(res, 200, {
        ...base,
        host: this.opts.host,
        startedAt: this.opts.startedAt,
        botName: s.botName,
        backend: s.backend,
        model: s.model,
        activeChats: s.activeChats,
        capabilities: ["mesh", "mesh-commands", "mesh-file-stream"],
      });
    }

    // Node provisioning runs PRE-AUTH by design: the target host holds no
    // bridge credential yet — the single-use grant token (minted by
    // make_node_install_link, expiring, one serve per leg) is the entire
    // authorization, the same trust model as streamed-transfer tokens.
    if (
      method === "GET" &&
      (path === "/node/install" || path === "/node/binary")
    ) {
      const token = url.searchParams.get("provision") ?? "";
      const unknown = () =>
        this.json(res, 404, {
          ok: false,
          error: "Unknown, expired, or already-used provisioning token",
        });
      if (!token) return unknown();
      if (path === "/node/install") {
        const install = this.handlers.openNodeInstall(token);
        if (!install) return unknown();
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${install.filename}"`,
          ...this.corsHeaders(),
        });
        res.end(install.script);
        return;
      }
      const binary = this.handlers.openNodeBinary(token);
      if (!binary) return unknown();
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(binary.size),
        ...this.corsHeaders(),
      });
      const stream = createReadStream(binary.path);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }

    if (auth !== "ok") {
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

      if (method === "POST" && path === "/chats/interrupt") {
        const body = await this.readJson(req);
        const ok = await this.handlers.interruptTurn(
          asString(body.chatId) ?? "",
        );
        return this.json(res, 200, { ok });
      }

      if (method === "POST" && path === "/chats/pulse") {
        const body = await this.readJson(req);
        this.handlers.setPulse(asString(body.chatId) ?? "", body.on === true);
        return this.json(res, 200, { ok: true });
      }

      if (method === "POST" && path === "/queue") {
        const body = await this.readJson(req);
        this.handlers.queueMessage(
          asString(body.chatId) ?? "",
          asString(body.text) ?? "",
        );
        return this.json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/history") {
        const id = url.searchParams.get("chatId") ?? "";
        const before = asPositiveInt(url.searchParams.get("before"));
        const limit = asPositiveInt(url.searchParams.get("limit"));
        return this.json(res, 200, {
          chatId: id,
          messages: this.handlers.history(id, { before, limit }),
        });
      }

      if (method === "GET" && path === "/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return this.json(res, 400, { ok: false, error: "q required" });
        const chatId = url.searchParams.get("chatId") ?? undefined;
        return this.json(res, 200, {
          results: this.handlers.search(q, chatId),
        });
      }

      if (method === "POST" && path === "/send") {
        const body = await this.readJson(req);
        const id = asString(body.chatId) ?? "";
        const text = asString(body.text) ?? "";
        const imagePath = asString(body.imagePath);
        const attachmentPath = asString(body.attachmentPath);
        // Text may be empty when an image is attached; require one or the other.
        if (!id || (!text.trim() && !attachmentPath))
          return this.json(res, 400, {
            ok: false,
            error: "chatId and text (or an attachment) required",
          });
        this.handlers.send(id, text, { imagePath, attachmentPath });
        return this.json(res, 202, { ok: true });
      }

      if (method === "POST" && path === "/devices/register") {
        const body = await this.readJson(req);
        const device = await this.handlers.registerDevice(body);
        return this.json(res, 200, { ok: true, deviceId: device.id });
      }

      if (method === "POST" && path === "/location") {
        const body = await this.readJson(req);
        await this.handlers.storeLocation(body);
        return this.json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/devices") {
        return this.json(res, 200, await this.handlers.listDevices());
      }

      if (method === "POST" && path === "/devices/command-result") {
        const body = await this.readJson(req);
        // ok:false for a late/unknown correlation id — not an HTTP error,
        // the device's POST was well-formed; nothing was waiting anymore.
        return this.json(res, 200, {
          ok: this.handlers.completeCommand(body),
        });
      }

      // Streamed device file transfers (see core/mesh/transfers.ts). The
      // one-time `transfer` token authorizes exactly one direction+path;
      // these sit behind the bridge bearer auth like every device route.
      if (path === "/devices/file") {
        const token = url.searchParams.get("transfer") ?? "";
        if (!token)
          return this.json(res, 400, { ok: false, error: "transfer required" });
        if (method === "POST") {
          const result = await this.handlers.acceptFileUpload(token, req);
          return this.json(res, result.ok ? 200 : 409, result);
        }
        if (method === "GET") {
          const file = await this.handlers.openFileDownload(token);
          if (!file)
            return this.json(res, 404, {
              ok: false,
              error: "Unknown or already-used transfer token",
            });
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(file.size),
            ...this.corsHeaders(),
          });
          const stream = createReadStream(file.path);
          stream.on("error", () => res.destroy());
          stream.pipe(res);
          return;
        }
      }

      if (method === "POST" && path === "/upload") {
        const filename = url.searchParams.get("filename") ?? "upload";
        const contentType =
          req.headers["content-type"] ?? "application/octet-stream";
        const bytes = await this.readRaw(req, MAX_UPLOAD_BYTES);
        if (!bytes.length)
          return this.json(res, 400, { ok: false, error: "Empty upload" });
        const result = await this.handlers.upload(filename, contentType, bytes);
        return this.json(res, 200, { ok: true, ...result });
      }

      if (method === "GET" && path === "/models") {
        const id = url.searchParams.get("chatId") ?? undefined;
        return this.json(res, 200, await this.handlers.listModels(id));
      }

      if (method === "POST" && path === "/model") {
        const body = await this.readJson(req);
        this.handlers.setModel(
          asString(body.chatId) ?? "",
          asString(body.model) ?? "",
        );
        return this.json(res, 200, { ok: true });
      }

      if (method === "GET" && path === "/backends") {
        const id = url.searchParams.get("chatId") ?? "";
        return this.json(res, 200, this.handlers.listBackends(id));
      }

      if (method === "POST" && path === "/backend") {
        const body = await this.readJson(req);
        // Always 200: ok/error is an application result the client renders,
        // not an HTTP-level failure (the client's decoder drops >=400 bodies).
        const result = await this.handlers.setBackend(
          asString(body.chatId) ?? "",
          asString(body.backend) ?? "",
        );
        return this.json(res, 200, result);
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

      if (method === "GET" && path === "/media") {
        const id = url.searchParams.get("id") ?? "";
        return await this.serveMedia(res, id);
      }

      if (method === "GET" && path === "/logs") {
        const lines = Math.min(
          asPositiveInt(url.searchParams.get("lines")) ?? 200,
          1000,
        );
        const level = url.searchParams.get("level") ?? "";
        const component = url.searchParams.get("component") ?? undefined;
        return this.json(res, 200, {
          entries: this.handlers.logs({
            lines,
            minLevel: isLogLevel(level) ? level : undefined,
            component,
          }),
        });
      }

      if (method === "GET" && path === "/plugins")
        return this.json(res, 200, { plugins: this.handlers.listPlugins() });

      if (method === "POST" && path === "/plugins/toggle") {
        const body = await this.readJson(req);
        // Always 200: ok/error is an application result the client renders,
        // not an HTTP-level failure (mirrors /backend).
        const result = await this.handlers.setPluginEnabled(
          asString(body.name) ?? "",
          body.enabled === true,
        );
        return this.json(res, 200, result);
      }

      if (method === "GET" && path === "/skills")
        return this.json(res, 200, { skills: this.handlers.listSkills() });

      if (method === "POST" && path === "/skills/toggle") {
        const body = await this.readJson(req);
        const result = this.handlers.setSkillEnabled(
          asString(body.name) ?? "",
          body.enabled === true,
        );
        return this.json(res, 200, result);
      }

      if (method === "GET" && path === "/config")
        return this.json(res, 200, this.handlers.getConfig());

      if (method === "POST" && path === "/config") {
        const body = await this.readJson(req);
        return this.json(res, 200, this.handlers.setConfig(body));
      }

      if (method === "POST" && path === "/control") {
        const body = await this.readJson(req);
        // Always 200: ok/message is an application result the client renders,
        // not an HTTP-level failure (mirrors /backend).
        const result = await this.handlers.control(asString(body.action) ?? "");
        return this.json(res, 200, result);
      }

      return this.json(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.json(res, 400, { ok: false, error: msg });
    }
  }

  /** Stream an attached image by id. Auth is already enforced by `handle`. */
  private async serveMedia(res: ServerResponse, id: string): Promise<void> {
    const filePath = id ? this.handlers.mediaPath(id) : null;
    if (!filePath) {
      return this.json(res, 404, { ok: false, error: "No such media" });
    }
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        return this.json(res, 404, { ok: false, error: "No such media" });
      }
      res.writeHead(200, {
        ...this.corsHeaders(),
        "Content-Type": contentTypeFor(filePath),
        "Content-Length": String(info.size),
        "Cache-Control": "private, max-age=3600",
      });
      const stream = createReadStream(filePath);
      stream.on("error", () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      stream.pipe(res);
    } catch {
      return this.json(res, 404, { ok: false, error: "No such media" });
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
    // Replay any in-progress turn so a client that connected mid-turn (or
    // reconnected after a blip) sees the tool timeline immediately, not just
    // the tools that fire after it joined.
    try {
      for (const event of this.handlers.liveTurnEvents()) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      logError("native", "Failed to replay live turn to new client", err);
    }
    this.clients.add(res);
    logDebug("native", `SSE client connected (${this.clients.size} total)`);
    res.on("close", () => {
      this.clients.delete(res);
      logDebug("native", `SSE client left (${this.clients.size} total)`);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private authState(req: IncomingMessage, url: URL): AuthState {
    if (!this.opts.token) return "ok";
    const header = req.headers["authorization"];
    const fromHeader =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : null;
    // EventSource can't set headers, so SSE clients pass ?token=… instead.
    const candidate = fromHeader ?? url.searchParams.get("token");
    if (candidate === null) return "anonymous";
    return this.tokenMatches(candidate) ? "ok" : "bad";
  }

  private authLockedOut(remote: string): boolean {
    const entry = this.authFailures.get(remote);
    if (!entry) return false;
    if (Date.now() >= entry.resetAt) {
      this.authFailures.delete(remote);
      return false;
    }
    return entry.count >= AUTH_LOCKOUT_MAX_FAILURES;
  }

  private recordAuthFailure(remote: string): void {
    const now = Date.now();
    const entry = this.authFailures.get(remote);
    if (!entry || now >= entry.resetAt) {
      if (this.authFailures.size >= AUTH_LOCKOUT_MAX_TRACKED) {
        for (const [ip, e] of this.authFailures) {
          if (now >= e.resetAt) this.authFailures.delete(ip);
        }
        // Still saturated after pruning live entries — under that much churn
        // dropping the newest attacker beats unbounded growth.
        if (this.authFailures.size >= AUTH_LOCKOUT_MAX_TRACKED) return;
      }
      this.authFailures.set(remote, {
        count: 1,
        resetAt: now + AUTH_LOCKOUT_WINDOW_MS,
      });
      return;
    }
    entry.count++;
    if (entry.count === AUTH_LOCKOUT_MAX_FAILURES) {
      logWarn(
        "native",
        `Bridge auth lockout for ${remote} (${AUTH_LOCKOUT_MAX_FAILURES} wrong tokens in ${AUTH_LOCKOUT_WINDOW_MS / 60_000}m)`,
      );
    }
  }

  /**
   * Constant-time token comparison. Hashing both sides first equalizes
   * lengths (timingSafeEqual demands it) without leaking the real length.
   */
  private tokenMatches(candidate: string | null): boolean {
    if (candidate === null || !this.opts.token) return false;
    return timingSafeEqual(
      createHash("sha256").update(candidate).digest(),
      createHash("sha256").update(this.opts.token).digest(),
    );
  }

  private corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      // Every response states its type; never let a browser guess one.
      "X-Content-Type-Options": "nosniff",
    };
  }

  private jsonHeaders(): Record<string, string> {
    return { ...this.corsHeaders(), "Content-Type": "application/json" };
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, this.jsonHeaders());
    res.end(JSON.stringify(body));
  }

  /** Read a raw request body (binary-safe) up to `max` bytes. */
  private async readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > max) throw new Error("Upload too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
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

/** Parse a positive-integer query param; undefined when absent/invalid. */
function asPositiveInt(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Minimal image content-type map for the media endpoint. */
function contentTypeFor(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
