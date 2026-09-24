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
import { log, logError, logDebug, logWarn } from "../../../util/log.js";
import { formatFingerprint, type BridgeTlsIdentity } from "./tls.js";
import { contentTypeFor } from "../media/media.js";
import { type BridgeEvent } from "../protocol.js";
import { buildRoutes } from "./routes/index.js";
import type { BridgeServerHandlers, RouteHost } from "./routes/host.js";
import {
  BRIDGE_ROUTE_AUTH,
  type AuthState,
  type BridgeRouteKey,
  type RouteContext,
  type RouteHandler,
} from "./routes/table.js";
import {
  describeTier,
  hasScope,
  resolvePrincipal,
  routeAllows,
  type BridgeCredentials,
  type BridgePrincipal,
} from "./credentials/principal.js";

export type { BridgeServerHandlers, SendOptions } from "./routes/host.js";
export { BRIDGE_ROUTE_AUTH, type BridgeRouteKey } from "./routes/table.js";
export type { BridgeCredentials } from "./credentials/principal.js";

/** One live SSE connection: the device it claimed and who opened it. */
type StreamSession = {
  deviceId: string | undefined;
  principal: BridgePrincipal;
};

const SSE_PING_MS = 25_000;
const MAX_BODY_BYTES = 256 * 1024;
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

export class BridgeServer {
  private server: Server | null = null;
  /**
   * Live SSE connections → the mesh device id each one claimed on connect
   * (undefined for clients that didn't claim one: desktop UIs, and companion
   * builds from before the claim existed) and the principal that opened it.
   * The claim is what makes `sendToDevice` addressable rather than a shout;
   * the principal is what lets a revocation find and drop the session.
   */
  private clients = new Map<ServerResponse, StreamSession>();
  private unsubscribeRevocations: (() => void) | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private port = 0;
  private tlsIdentity: BridgeTlsIdentity | null = null;
  /** Wrong-token counts per remote address (behind a proxy: per proxy). */
  private authFailures = new Map<string, { count: number; resetAt: number }>();
  /** `METHOD /path` → handler; a Map so lookups only ever hit own entries. */
  private readonly routes: ReadonlyMap<BridgeRouteKey, RouteHandler>;

  constructor(
    private readonly opts: {
      host: string;
      port: number;
      token?: string;
      /** Origins permitted to call the bridge from a browser. Empty by
       *  default: native clients send no Origin and need no entry here. */
      allowedOrigins?: readonly string[];
      startedAt: string;
      /**
       * When present, the bridge serves HTTPS with this identity. A provider
       * (not the identity itself) so the transport stays free of key-file
       * I/O — it resolves once, inside `start()`.
       */
      tls?: () => Promise<BridgeTlsIdentity>;
      /**
       * Per-device credentials (core/mesh/credentials) and the migration
       * policy. Absent: the shared `token` is the only credential, as
       * before.
       */
      credentials?: BridgeCredentials;
    },
    private readonly handlers: BridgeServerHandlers,
  ) {
    this.routes = new Map(
      Object.entries(buildRoutes(this.routeHost())) as [
        BridgeRouteKey,
        RouteHandler,
      ][],
    );
  }

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

  /**
   * Push an event to every connected SSE client that may see it. Chat
   * traffic is for `client`-scoped sessions only; a device-only credential
   * hears the mesh-wide `locate` and nothing else.
   */
  broadcast(event: BridgeEvent): void {
    if (this.clients.size === 0) return;
    const targets: ServerResponse[] = [];
    for (const [res, session] of this.clients) {
      if (event.kind === "locate" || hasScope(session.principal, "client")) {
        targets.push(res);
      }
    }
    this.write(targets, event);
  }

  /**
   * End every live stream opened with one of `credentialIds` — revocation
   * (and a scope change) must bite now, not at the client's next request.
   */
  dropCredentialSessions(credentialIds: readonly string[]): number {
    let dropped = 0;
    for (const [res, { principal }] of this.clients) {
      if (
        principal.kind === "device" &&
        credentialIds.includes(principal.credentialId)
      ) {
        this.clients.delete(res);
        try {
          res.end();
        } catch {
          /* already gone */
        }
        dropped++;
      }
    }
    if (dropped > 0) {
      log(
        "native",
        `Dropped ${dropped} live session(s) of revoked/changed credential(s) ${credentialIds.join(", ")}`,
      );
    }
    return dropped;
  }

  /**
   * Push an event to the client(s) that claimed `deviceId` — the delivery
   * path for anything addressed to ONE device.
   *
   * Device commands are not public: their params carry one-time transfer
   * tokens, exec command lines, remote paths, and — on the chunked fallback —
   * whole base64 file bodies. Broadcasting them handed every connected client
   * another device's secrets and relied on each client discarding what wasn't
   * addressed to it, which is courtesy, not enforcement.
   *
   * A claim is an ADDRESS, not a credential: any client holding the bridge
   * token could claim any id, and the bridge token is (still) the only trust
   * boundary here. What this buys is that a device no longer passively
   * receives traffic meant for its peers.
   *
   * Clients that claimed nothing are the fallback audience, and only when the
   * target claimed nothing either: a companion build that predates the claim
   * can't be addressed, and dropping its commands would take the mesh offline
   * for it. So an updated device's traffic never reaches them — the fallback
   * shrinks to nothing as the fleet updates. Only shared-token sessions are
   * in that fallback: a per-device credential is its own device or nobody.
   *
   * With per-device credentials the claim IS enforced: a credential can
   * only claim the device it is bound to (credentials/claims.ts).
   */
  sendToDevice(deviceId: string, event: BridgeEvent): void {
    if (this.clients.size === 0) return;
    const claimed: ServerResponse[] = [];
    const unclaimed: ServerResponse[] = [];
    for (const [res, { deviceId: id, principal }] of this.clients) {
      if (id === deviceId) claimed.push(res);
      else if (id === undefined && principal.kind !== "device") {
        unclaimed.push(res);
      }
    }
    if (claimed.length === 0) {
      logDebug(
        "native",
        `No SSE client claims device ${deviceId} — delivering to ${unclaimed.length} unclaimed client(s)`,
      );
    }
    this.write(claimed.length > 0 ? claimed : unclaimed, event);
  }

  private write(targets: Iterable<ServerResponse>, event: BridgeEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of targets) {
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
      for (const res of this.clients.keys()) {
        try {
          res.write(": ping\n\n");
        } catch {
          /* evicted on close */
        }
      }
    }, SSE_PING_MS);
    this.pingTimer.unref?.();
    this.unsubscribeRevocations = this.opts.credentials?.authority.onRevoked(
      (ids) => this.dropCredentialSessions(ids),
    );

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
    this.unsubscribeRevocations?.();
    this.unsubscribeRevocations = undefined;
    for (const res of this.clients.keys()) {
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

    // Origin / Host guard runs before everything, including OPTIONS: a
    // preflight that answers 204 to any origin is itself the permission
    // slip the browser is asking for.
    const origin =
      typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const refusal = this.originGuard(req);
    if (refusal !== undefined) {
      res.writeHead(403, {
        ...this.corsHeaders(),
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ok: false, error: refusal }));
      return;
    }
    // Set once here rather than in corsHeaders(): setHeader values survive
    // every later writeHead(code, {...}) that does not name the same key,
    // so each of the response sites keeps the grant without threading the
    // origin through all of them.
    if (origin !== undefined && this.isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

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

    const { state: auth, principal } = this.authState(req, url);
    if (auth === "bad") this.recordAuthFailure(remote);
    else if (auth === "ok") this.authFailures.delete(remote);

    const key = `${method} ${path}` as BridgeRouteKey;
    const route = this.routes.get(key);
    const ctx: RouteContext = { req, res, url, auth, principal };
    const tier = route ? BRIDGE_ROUTE_AUTH[key] : undefined;

    if (route && tier === "public") {
      await route(ctx);
      return;
    }
    // Unknown routes are 401 before they are 404: an unauthenticated caller
    // learns nothing about the route map.
    if (auth !== "ok" || principal === null) {
      return this.json(res, 401, { ok: false, error: "Unauthorized" });
    }
    if (!route || tier === undefined) {
      return this.json(res, 404, { ok: false, error: "Not found" });
    }
    // Authenticated, but is this credential allowed HERE? The scope each
    // route needs is declared in routes/table.ts.
    if (!routeAllows(tier, principal)) {
      return this.json(res, 403, {
        ok: false,
        error: `This credential lacks the ${describeTier(tier)} scope ${key} requires`,
      });
    }

    try {
      await route(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.json(res, 400, { ok: false, error: msg });
    }
  }

  /** The surface the route modules get — bound closures, never the class. */
  private routeHost(): RouteHost {
    return {
      handlers: this.handlers,
      opts: this.opts,
      port: () => this.port,
      scheme: () => this.getScheme(),
      fingerprint: () => this.getFingerprint(),
      json: (res, code, body) => this.json(res, code, body),
      readJson: (req) => this.readJson(req),
      corsHeaders: () => this.corsHeaders(),
      streamFile: (res, file) => this.streamFile(res, file),
      serveMedia: (res, id) => this.serveMedia(res, id),
      openStream: (res, deviceId, principal) =>
        this.openStream(res, deviceId, principal),
      credentials: this.opts.credentials,
      unknownProvision: (res) => this.unknownProvision(res),
    };
  }

  private unknownProvision(res: ServerResponse): void {
    this.json(res, 404, {
      ok: false,
      error: "Unknown, expired, or already-used provisioning token",
    });
  }

  /** Stream a file whose size is already known as an octet-stream body. */
  private streamFile(
    res: ServerResponse,
    file: { path: string; size: number },
  ): void {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
      ...this.corsHeaders(),
    });
    const stream = createReadStream(file.path);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
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

  private openStream(
    res: ServerResponse,
    deviceId: string | undefined,
    principal: BridgePrincipal,
  ): void {
    // A device-only credential gets its own mesh traffic, not the chats.
    const seesChats = hasScope(principal, "client");
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
        chats: seesChats ? this.handlers.listChats() : [],
      })}\n\n`,
    );
    // Replay any in-progress turn so a client that connected mid-turn (or
    // reconnected after a blip) sees the tool timeline immediately, not just
    // the tools that fire after it joined.
    try {
      for (const event of seesChats ? this.handlers.liveTurnEvents() : []) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      logError("native", "Failed to replay live turn to new client", err);
    }
    this.clients.set(res, { deviceId, principal });
    logDebug(
      "native",
      `SSE client connected${deviceId ? ` as device ${deviceId}` : ""} (${this.clients.size} total)`,
    );
    res.on("close", () => {
      this.clients.delete(res);
      logDebug("native", `SSE client left (${this.clients.size} total)`);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private authState(
    req: IncomingMessage,
    url: URL,
  ): { state: AuthState; principal: BridgePrincipal | null } {
    if (!this.opts.token) return { state: "ok", principal: { kind: "open" } };
    const header = req.headers["authorization"];
    const fromHeader =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : null;
    // EventSource can't set headers, so SSE clients pass ?token=… instead.
    const candidate = fromHeader ?? url.searchParams.get("token");
    if (candidate === null) return { state: "anonymous", principal: null };
    // The shared token or a per-device credential (credentials/principal.ts).
    const principal = resolvePrincipal(
      candidate,
      req,
      (c) => this.tokenMatches(c),
      this.opts.credentials,
    );
    return principal
      ? { state: "ok", principal }
      : { state: "bad", principal: null };
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

  /**
   * CORS headers.
   *
   * Deliberately NOT `Access-Control-Allow-Origin: *`. The bridge's clients
   * are native apps (Electron main process, Flutter, curl, talon-node),
   * which send no `Origin` at all — a wildcard buys them nothing and hands
   * every web page on the internet a readable cross-origin channel to the
   * agent API. Only an explicitly configured origin is echoed back.
   */
  private corsHeaders(): Record<string, string> {
    return {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      // Every response states its type; never let a browser guess one.
      "X-Content-Type-Options": "nosniff",
    };
  }

  /** True when `origin` is on the operator's `native.allowedOrigins` list. */
  private isAllowedOrigin(origin: string): boolean {
    return this.opts.allowedOrigins?.includes(origin) ?? false;
  }

  /**
   * Reject browser-driven cross-origin requests and DNS-rebinding.
   *
   * Two independent checks, because they stop different attacks:
   *
   *   - `Origin`: browsers attach it to every cross-origin request and
   *     scripts cannot forge it. Native clients omit it entirely. So "an
   *     Origin we did not allow" means "a web page is driving us" — which,
   *     on the default unauthenticated loopback bind, would let any site
   *     the user visits POST /send and run tools on this machine.
   *   - `Host`: a name that resolves to 127.0.0.1 makes the request
   *     SAME-origin, so no Origin header is sent and the check above never
   *     fires. Pinning Host to loopback/the configured bind closes that.
   *
   * Returns an error string when the request must be refused.
   */
  private originGuard(req: IncomingMessage): string | undefined {
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== "null") {
      if (!this.isAllowedOrigin(origin)) {
        return `Origin ${origin} is not allowed. Add it to native.allowedOrigins to permit browser clients.`;
      }
    }

    const host = req.headers.host;
    if (typeof host === "string" && host !== "") {
      // Strip the port; bracketed IPv6 keeps its brackets off.
      const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      const allowed =
        name === "127.0.0.1" ||
        name === "localhost" ||
        name === "::1" ||
        name === this.opts.host ||
        // A wildcard bind is reachable under every local name; the bearer
        // token is the control there, not the Host header.
        this.opts.host === "0.0.0.0" ||
        this.opts.host === "::";
      if (!allowed) {
        return `Host ${host} is not recognised for this bridge (DNS-rebinding guard).`;
      }
    }
    return undefined;
  }

  private jsonHeaders(): Record<string, string> {
    return { ...this.corsHeaders(), "Content-Type": "application/json" };
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, this.jsonHeaders());
    res.end(JSON.stringify(body));
  }

  /** Read a raw request body (binary-safe) up to `max` bytes. */
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
