/**
 * Bridge origin / Host guard.
 *
 * The bridge's default posture is loopback with NO token, because a
 * single-machine companion app needs no pairing. That makes the browser
 * boundary the only thing standing between a web page the user happens to
 * visit and the agent API — and `POST /send` runs the agent's tools, so
 * "a page can reach the bridge" means "a page can run code on this host".
 *
 * Two independent checks, tested here because they stop different attacks:
 *   - Origin: browsers attach it cross-origin and scripts cannot forge it.
 *   - Host:   a name resolving to 127.0.0.1 is SAME-origin, so no Origin
 *             header is sent at all and only Host pinning catches it.
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { BridgeServer } from "../frontend/native/server.js";

type Res = { status: number; acao: string | undefined };

/** Raw request — `fetch` forbids setting Host, which is half of what we test. */
function raw(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<Res> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (rp) => {
        rp.resume();
        resolve({
          status: rp.statusCode ?? 0,
          acao: rp.headers["access-control-allow-origin"] as string | undefined,
        });
      },
    );
    req.end();
  });
}

const sent: Array<{ id: string; text: string }> = [];

const handlers = new Proxy({} as Record<string, unknown>, {
  get: (_t, key) => {
    if (key === "listChats") return () => [{ id: "c1", title: "Private" }];
    if (key === "send")
      return (id: string, text: string) => void sent.push({ id, text });
    if (key === "liveTurnEvents") return () => [];
    return () => ({});
  },
});

let server: BridgeServer | null = null;

async function start(opts: Record<string, unknown> = {}): Promise<number> {
  server = new BridgeServer(
    {
      host: "127.0.0.1",
      port: 0,
      startedAt: new Date(0).toISOString(),
      ...opts,
    },
    handlers as never,
  );
  await server.start();
  return server.getPort();
}

afterEach(async () => {
  await server?.stop();
  server = null;
  sent.length = 0;
});

const EVIL = "https://evil.example.com";

describe("bridge origin guard (default: loopback, no token)", () => {
  it("refuses a cross-origin GET from a web page", async () => {
    const port = await start();
    const res = await raw(port, "/chats", { Origin: EVIL });
    expect(res.status).toBe(403);
    expect(res.acao).toBeUndefined();
  });

  // The preflight has to be refused too. A 204 that echoes permissive CORS
  // to any origin IS the permission slip the browser is asking for.
  it("refuses the preflight rather than green-lighting the real request", async () => {
    const port = await start();
    const res = await raw(port, "/send", { Origin: EVIL }, "OPTIONS");
    expect(res.status).toBe(403);
    expect(res.acao).toBeUndefined();
  });

  it("refuses POST /send, so a page cannot drive the agent", async () => {
    const port = await start();
    const res = await raw(
      port,
      "/send",
      { Origin: EVIL, "Content-Type": "application/json" },
      "POST",
    );
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  // DNS rebinding: attacker.com resolves to 127.0.0.1, so the browser
  // treats it as same-origin and sends no Origin header at all.
  it("refuses a Host that is not this bridge (DNS rebinding)", async () => {
    const port = await start();
    const res = await raw(port, "/chats", { Host: "attacker.com" });
    expect(res.status).toBe(403);
  });

  it("accepts loopback Host spellings", async () => {
    const port = await start();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await raw(port, "/chats", { Host: host })).status).toBe(200);
    }
  });

  // Native clients — Electron main, Flutter, curl, talon-node — send no
  // Origin. The guard must be invisible to them.
  it("leaves native clients (no Origin header) untouched", async () => {
    const port = await start();
    expect((await raw(port, "/chats")).status).toBe(200);
    expect((await raw(port, "/health")).status).toBe(200);
  });
});

describe("bridge origin guard (allowedOrigins configured)", () => {
  it("admits a listed origin and echoes it back", async () => {
    const port = await start({ allowedOrigins: [EVIL] });
    const res = await raw(port, "/chats", { Origin: EVIL });
    expect(res.status).toBe(200);
    expect(res.acao).toBe(EVIL);
  });

  // Regression guard: the grant has to reach ordinary responses, not just
  // the preflight, or a browser client passes CORS then cannot read a thing.
  it("echoes the origin on real responses, not only the preflight", async () => {
    const port = await start({ allowedOrigins: [EVIL] });
    expect((await raw(port, "/send", { Origin: EVIL }, "OPTIONS")).acao).toBe(
      EVIL,
    );
    expect((await raw(port, "/chats", { Origin: EVIL })).acao).toBe(EVIL);
  });

  it("still refuses an origin that is not on the list", async () => {
    const port = await start({ allowedOrigins: ["https://good.example.com"] });
    expect((await raw(port, "/chats", { Origin: EVIL })).status).toBe(403);
  });

  it("never answers with a wildcard origin", async () => {
    const port = await start({ allowedOrigins: [EVIL] });
    for (const r of [
      await raw(port, "/chats", { Origin: EVIL }),
      await raw(port, "/chats"),
      await raw(port, "/send", { Origin: EVIL }, "OPTIONS"),
    ]) {
      expect(r.acao).not.toBe("*");
    }
  });
});
