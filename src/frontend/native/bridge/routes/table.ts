import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * ok: request carries the right token (or none is required).
 * anonymous: no credential presented — a pre-pairing probe, not an attack.
 * bad: a credential was presented and it is wrong.
 */
export type AuthState = "ok" | "anonymous" | "bad";

/**
 * "public": served without a bearer token. Every entry is gated some other
 * way — a single-use grant minted by the daemon, or (for /health) by
 * answering only what pairing needs until a token is presented.
 * "bearer": the request must carry the bridge token.
 */
export type BridgeRouteAuth = "public" | "bearer";

/**
 * The bridge's routes and the auth tier of each — declared once, here,
 * rather than implied by where an `if` sits relative to the auth check.
 * The security posture of the transport is this table: a route is
 * pre-auth only by appearing in it as "public", and the route test walks
 * every entry and proves the tier holds on the wire. Adding a route
 * without an entry is a type error (`buildRoutes` is exhaustive over
 * these keys); adding one as "public" is a diff a reviewer sees.
 */
export const BRIDGE_ROUTE_AUTH = {
  // Pre-auth by design. /health serves pairing data (identity, protocol,
  // fingerprint) to anyone and the operational view only to a token
  // holder. /pair, /node/install and /node/binary hand over a credential
  // to a device that holds none yet; the single-use grant in the query is
  // the entire authorization.
  "GET /health": "public",
  "GET /pair": "public",
  "GET /node/install": "public",
  "GET /node/binary": "public",

  // Everything a client can do once paired.
  "GET /events": "bearer",
  "GET /chats": "bearer",
  "POST /chats": "bearer",
  "POST /chats/rename": "bearer",
  "POST /chats/delete": "bearer",
  "POST /chats/reset": "bearer",
  "POST /chats/interrupt": "bearer",
  "POST /chats/pulse": "bearer",
  "POST /queue": "bearer",
  "GET /history": "bearer",
  "GET /search": "bearer",

  // Memory — read-only. The typed memory store is readable over the
  // bridge but never writable from it: asserting and dropping stay with
  // the daemon's own write path.
  "GET /memory": "bearer",
  "GET /memory/why": "bearer",

  "POST /send": "bearer",
  "POST /upload": "bearer",
  "GET /media": "bearer",
  "GET /models": "bearer",
  "POST /model": "bearer",
  "GET /backends": "bearer",
  "POST /backend": "bearer",
  "GET /effort": "bearer",
  "POST /effort": "bearer",
  "GET /logs": "bearer",
  "GET /plugins": "bearer",
  "POST /plugins/toggle": "bearer",
  "GET /skills": "bearer",
  "POST /skills/toggle": "bearer",
  "GET /config": "bearer",
  "POST /config": "bearer",
  "POST /control": "bearer",

  // Mesh. The one-time `transfer` token on /devices/file authorizes one
  // direction+path, but the route still sits behind the bearer like every
  // device route — the token is a scope, not a credential.
  "POST /devices/register": "bearer",
  "POST /location": "bearer",
  "GET /devices": "bearer",
  "POST /devices/command-result": "bearer",
  "POST /devices/file": "bearer",
  "GET /devices/file": "bearer",
} as const satisfies Record<string, BridgeRouteAuth>;

export type BridgeRouteKey = keyof typeof BRIDGE_ROUTE_AUTH;

/** What a route handler receives; `auth` is already evaluated. */
export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  auth: AuthState;
};

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

/** Every route with its handler — exhaustive over BRIDGE_ROUTE_AUTH by construction. */
export type BridgeRoutes = Record<BridgeRouteKey, RouteHandler>;
