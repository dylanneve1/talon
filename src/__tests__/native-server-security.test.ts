import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  BridgeServer,
  type BridgeServerHandlers,
} from "../frontend/native/server.js";

const handlers: BridgeServerHandlers = {
  status: () => ({
    app: "talon-bridge",
    protocol: 1,
    botName: "Talon",
    backend: "test",
    model: "m1",
    activeChats: 2,
    startedAt: "now",
  }),
  listChats: () => [],
  createChat: () => {
    throw new Error("unused");
  },
  renameChat: () => null,
  deleteChat: () => false,
  history: () => [],
  search: () => [],
  send: () => {},
  upload: async () => ({ imagePath: "", path: "" }),
  listModels: () => ({ active: "", models: [] }),
  setModel: () => {},
  listBackends: () => ({ active: "", backends: [] }),
  setBackend: async () => ({ ok: true }),
  setEffort: () => {},
  effortLevels: async () => ({ active: "", levels: [] }),
  listPlugins: () => [],
  setPluginEnabled: async () => ({ ok: true }),
  listSkills: () => [],
  setSkillEnabled: () => ({ ok: true }),
  resetChat: () => false,
  interruptTurn: async () => false,
  setPulse: () => {},
  queueMessage: () => {},
  getConfig: () => ({}) as never,
  setConfig: () => ({}) as never,
  control: async () => ({ ok: true, message: "" }),
  logs: () => [],
  liveTurnEvents: () => [],
  mediaPath: () => null,
  registerDevice: async () => ({}) as never,
  storeLocation: async () => ({}) as never,
  listDevices: () => ({ devices: [], locations: [] }),
  completeCommand: () => false,
  acceptFileUpload: async () => ({ ok: false, error: "unused" }),
  openFileDownload: async () => null,
};

describe("bridge server security posture", () => {
  let server: BridgeServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function startServer(token?: string): Promise<number> {
    server = new BridgeServer(
      { host: "127.0.0.1", port: 0, token, startedAt: "boot" },
      handlers,
    );
    return server.start();
  }

  const get = (port: number, path: string, token?: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  it("serves only pairing data on unauthenticated /health", async () => {
    const port = await startServer("secret");
    const res = await get(port, "/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.app).toBe("talon-bridge");
    expect(body.authRequired).toBe(true);
    expect(typeof body.protocol).toBe("number");
    for (const leaked of [
      "botName",
      "backend",
      "model",
      "activeChats",
      "startedAt",
      "host",
      "capabilities",
    ]) {
      expect(body).not.toHaveProperty(leaked);
    }
  });

  it("serves the full /health to an authenticated client", async () => {
    const port = await startServer("secret");
    const body = (await (
      await get(port, "/health", "secret")
    ).json()) as Record<string, unknown>;
    expect(body.botName).toBe("Talon");
    expect(body.backend).toBe("test");
    expect(body.activeChats).toBe(2);
    expect(body.startedAt).toBe("boot");
  });

  it("keeps the full /health when no token is configured (local use)", async () => {
    const port = await startServer();
    const body = (await (await get(port, "/health")).json()) as Record<
      string,
      unknown
    >;
    expect(body.botName).toBe("Talon");
    expect(body.authRequired).toBe(false);
  });

  it("locks out an address after repeated wrong tokens", async () => {
    const port = await startServer("secret");
    for (let i = 0; i < 20; i++) {
      expect((await get(port, "/chats", "wrong")).status).toBe(401);
    }
    // Locked out now — even the correct token is refused for the window.
    const locked = await get(port, "/chats", "secret");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBeTruthy();
  });

  it("does not count tokenless probes toward the lockout", async () => {
    const port = await startServer("secret");
    for (let i = 0; i < 25; i++) {
      expect((await get(port, "/chats")).status).toBe(401);
    }
    expect((await get(port, "/chats", "secret")).status).toBe(200);
  });

  it("resets the failure count on a successful auth", async () => {
    const port = await startServer("secret");
    for (let i = 0; i < 19; i++) await get(port, "/chats", "wrong");
    expect((await get(port, "/chats", "secret")).status).toBe(200);
    // Counter cleared — 19 more misses still don't trip the lockout.
    for (let i = 0; i < 19; i++) await get(port, "/chats", "wrong");
    expect((await get(port, "/chats", "secret")).status).toBe(200);
  });

  it("marks every response nosniff", async () => {
    const port = await startServer("secret");
    for (const res of [
      await get(port, "/health"),
      await get(port, "/chats", "secret"),
      await get(port, "/chats", "wrong"),
    ]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});
