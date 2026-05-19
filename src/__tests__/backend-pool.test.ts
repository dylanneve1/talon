/**
 * Tests for the multi-role backend pool.
 *
 * Focus: refcounted instance sharing across roles, per-role rebinds,
 * cleanup only firing when the last role releases, and the
 * (role, backend, ctx) listener signature.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { QueryBackend } from "../core/types.js";
import type { TalonConfig } from "../util/config.js";
import {
  registerBackend,
  clearBackends,
  type BackendFactory,
} from "../backend/registry.js";
import {
  initBackendPool,
  getBackendForRole,
  getBackendIdForRole,
  getBackendLabelForRole,
  rebindRole,
  getPoolSnapshot,
  hasBackendPool,
  onBackendChange,
  cleanupBackendPool,
  resetBackendPoolForTest,
  clearBackendChangeListenersForTest,
} from "../core/backend-controller.js";

function makeStubBackend(label: string): QueryBackend {
  return {
    query: vi.fn(async () => ({
      text: `[${label}] reply`,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })),
  };
}

function makeFactory(
  id: string,
  label: string,
  opts: {
    initSpy?: (id: string) => void;
    cleanupSpy?: (id: string) => void;
    failInit?: boolean;
  } = {},
): BackendFactory {
  return {
    id,
    label,
    async init() {
      opts.initSpy?.(id);
      if (opts.failInit) {
        throw new Error(`init failed for ${id}`);
      }
      return {
        backend: makeStubBackend(label),
        cleanup: () => {
          opts.cleanupSpy?.(id);
        },
      };
    },
  };
}

function configFor(
  chat: string,
  heartbeat?: string,
  dream?: string,
): TalonConfig {
  return {
    backend: chat,
    heartbeatBackend: heartbeat,
    dreamBackend: dream,
  } as unknown as TalonConfig;
}

const STUB_CTX = {
  getBridgePort: () => 0,
  frontendName: "terminal" as const,
};

beforeEach(async () => {
  await cleanupBackendPool();
  resetBackendPoolForTest();
  clearBackendChangeListenersForTest();
  clearBackends();
});

describe("backend pool — multi-role bindings", () => {
  it("shares one instance when all three roles point at the same backend", async () => {
    const inits: string[] = [];
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );

    await initBackendPool(configFor("alpha"), STUB_CTX);
    expect(hasBackendPool()).toBe(true);

    // Single init even though three roles bound.
    expect(inits).toEqual(["alpha"]);

    // All three roles resolve to the same backend reference.
    const chat = getBackendForRole("chat");
    const heartbeat = getBackendForRole("heartbeat");
    const dream = getBackendForRole("dream");
    expect(chat).toBe(heartbeat);
    expect(heartbeat).toBe(dream);

    const snap = getPoolSnapshot();
    expect(snap.instances).toHaveLength(1);
    expect(snap.instances[0].roles).toEqual(["chat", "dream", "heartbeat"]);
    expect(snap.bindings).toEqual({
      chat: "alpha",
      heartbeat: "alpha",
      dream: "alpha",
    });

    await cleanupBackendPool();
    expect(cleanups).toEqual(["alpha"]);
  });

  it("spins up two instances when chat and heartbeat use different backends", async () => {
    const inits: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", { initSpy: (id) => inits.push(id) }),
    );
    registerBackend(
      makeFactory("beta", "Beta", { initSpy: (id) => inits.push(id) }),
    );

    await initBackendPool(configFor("alpha", "beta"), STUB_CTX);

    expect(inits).toEqual(["alpha", "beta"]);
    expect(getBackendIdForRole("chat")).toBe("alpha");
    expect(getBackendIdForRole("heartbeat")).toBe("beta");
    expect(getBackendIdForRole("dream")).toBe("alpha"); // falls back to chat

    const snap = getPoolSnapshot();
    expect(snap.instances).toHaveLength(2);
    expect(snap.instances.find((i) => i.id === "alpha")?.roles).toEqual([
      "chat",
      "dream",
    ]);
    expect(snap.instances.find((i) => i.id === "beta")?.roles).toEqual([
      "heartbeat",
    ]);
  });

  it("rebind to a backend already in the pool reuses the instance (no init)", async () => {
    const inits: string[] = [];
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    registerBackend(
      makeFactory("beta", "Beta", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );

    // chat=alpha, heartbeat=beta, dream=alpha → 2 instances
    await initBackendPool(configFor("alpha", "beta"), STUB_CTX);
    expect(inits).toEqual(["alpha", "beta"]);

    // Rebind dream from alpha → beta. beta is already pooled, so no
    // new init. alpha still has chat using it, so no cleanup.
    const result = await rebindRole(
      "dream",
      "beta",
      configFor("alpha", "beta"),
    );
    expect(result.ok).toBe(true);
    expect(result.newReused).toBe(true);
    expect(result.previousReused).toBe(true);
    expect(inits).toEqual(["alpha", "beta"]); // unchanged
    expect(cleanups).toEqual([]); // alpha still bound by chat

    const snap = getPoolSnapshot();
    expect(snap.instances.find((i) => i.id === "alpha")?.roles).toEqual([
      "chat",
    ]);
    expect(snap.instances.find((i) => i.id === "beta")?.roles).toEqual([
      "dream",
      "heartbeat",
    ]);
  });

  it("rebind that orphans an instance triggers cleanup", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    registerBackend(makeFactory("beta", "Beta"));
    registerBackend(makeFactory("gamma", "Gamma"));

    // chat=alpha, others default to alpha. So alpha has 3 roles.
    await initBackendPool(configFor("alpha"), STUB_CTX);

    // Rebind chat → beta. alpha now has 2 roles (heartbeat, dream).
    await rebindRole("chat", "beta", configFor("alpha"));
    expect(cleanups).toEqual([]);

    // Rebind heartbeat → gamma. alpha now has 1 role (dream).
    await rebindRole("heartbeat", "gamma", configFor("alpha"));
    expect(cleanups).toEqual([]);

    // Rebind dream → gamma. alpha is orphaned → cleanup fires.
    const result = await rebindRole("dream", "gamma", configFor("alpha"));
    expect(result.ok).toBe(true);
    expect(result.previousReused).toBe(false);
    expect(cleanups).toEqual(["alpha"]);
  });

  it("rejects rebind to the same id", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await initBackendPool(configFor("alpha"), STUB_CTX);

    const result = await rebindRole("chat", "alpha", configFor("alpha"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already bound/);
  });

  it("rejects rebind to unknown backend with helpful error", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initBackendPool(configFor("alpha"), STUB_CTX);

    const result = await rebindRole("chat", "ghost", configFor("alpha"));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown backend "ghost"/);
    expect(result.error).toMatch(/"alpha"/);
    expect(result.error).toMatch(/"beta"/);
  });

  it("keeps current binding when rebind init fails", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta", { failInit: true }));

    await initBackendPool(configFor("alpha"), STUB_CTX);
    const result = await rebindRole("chat", "beta", configFor("alpha"));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to init Beta/);
    expect(getBackendIdForRole("chat")).toBe("alpha");
  });

  it("initBackendPool rolls back partial init on failure", async () => {
    const inits: string[] = [];
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    registerBackend(
      makeFactory("beta", "Beta", {
        initSpy: (id) => inits.push(id),
        failInit: true,
      }),
    );

    await expect(
      initBackendPool(configFor("alpha", "beta"), STUB_CTX),
    ).rejects.toThrow(/init failed for beta/);

    // alpha was initialised successfully then rolled back.
    expect(inits).toEqual(["alpha", "beta"]);
    expect(cleanups).toEqual(["alpha"]);
    expect(hasBackendPool()).toBe(false);
  });

  it("listener receives the holder that changed", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    registerBackend(makeFactory("gamma", "Gamma"));
    await initBackendPool(configFor("alpha"), STUB_CTX);

    const calls: Array<{ holder: string; id: string }> = [];
    onBackendChange((holder, _b, info) => {
      calls.push({ holder, id: info.id });
    });

    await rebindRole("chat", "beta", configFor("alpha"));
    await rebindRole("heartbeat", "gamma", configFor("alpha"));
    // The listener receives the holder string (`role:<role>`), not
    // the bare role name — that's what lets per-chat overrides
    // surface to listeners alongside role rebinds.
    expect(calls).toEqual([
      { holder: "role:chat", id: "beta" },
      { holder: "role:heartbeat", id: "gamma" },
    ]);
  });

  it("per-chat overrides share pool entries with role bindings", async () => {
    const inits: string[] = [];
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    registerBackend(
      makeFactory("beta", "Beta", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    // initBackendPool isn't imported with a side door here, so reach
    // via the existing helpers — same exports.
    const ctrl = await import("../core/backend-controller.js");

    await ctrl.initBackendPool(configFor("alpha"), STUB_CTX);
    // Chat A pins beta as an override; pool now has 2 instances.
    await ctrl.rebindChat("chat-A", "beta", configFor("alpha"));
    expect(inits).toEqual(["alpha", "beta"]);
    expect(ctrl.getBackendIdForChat("chat-A")).toBe("beta");
    // Chat B has no override → falls back to global chat role (alpha).
    expect(ctrl.getBackendIdForChat("chat-B")).toBe("alpha");
    expect(ctrl.hasChatBackendOverride("chat-A")).toBe(true);
    expect(ctrl.hasChatBackendOverride("chat-B")).toBe(false);

    // Releasing chat A's override drops beta's refcount to 0 → cleanup.
    await ctrl.releaseChat("chat-A");
    expect(cleanups).toEqual(["beta"]);
    expect(ctrl.getBackendIdForChat("chat-A")).toBe("alpha");
    expect(ctrl.hasChatBackendOverride("chat-A")).toBe(false);
  });

  it("two chats on two backends both stay alive concurrently", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", { cleanupSpy: (id) => cleanups.push(id) }),
    );
    registerBackend(
      makeFactory("beta", "Beta", { cleanupSpy: (id) => cleanups.push(id) }),
    );
    registerBackend(
      makeFactory("gamma", "Gamma", { cleanupSpy: (id) => cleanups.push(id) }),
    );
    const ctrl = await import("../core/backend-controller.js");

    await ctrl.initBackendPool(configFor("alpha"), STUB_CTX);
    await ctrl.rebindChat("chat-A", "beta", configFor("alpha"));
    await ctrl.rebindChat("chat-B", "gamma", configFor("alpha"));

    // 3 instances live: alpha (chat-role + heartbeat + dream), beta
    // (chat-A), gamma (chat-B).
    const snap = ctrl.getPoolSnapshot();
    expect(snap.instances).toHaveLength(3);
    expect(snap.instances.find((i) => i.id === "beta")?.chats).toEqual([
      "chat-A",
    ]);
    expect(snap.instances.find((i) => i.id === "gamma")?.chats).toEqual([
      "chat-B",
    ]);

    // Releasing chat A doesn't affect chat B or alpha.
    await ctrl.releaseChat("chat-A");
    expect(cleanups).toEqual(["beta"]);
    expect(ctrl.getBackendIdForChat("chat-B")).toBe("gamma");
  });

  it("releaseChat on an unbound chat is a no-op", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    const ctrl = await import("../core/backend-controller.js");
    await ctrl.initBackendPool(configFor("alpha"), STUB_CTX);

    // Doesn't throw, doesn't break the pool.
    await ctrl.releaseChat("ghost-chat");
    expect(ctrl.getBackendIdForChat("ghost-chat")).toBe("alpha");
  });

  it("getBackendForRole throws when the role isn't bound", () => {
    expect(() => getBackendForRole("chat")).toThrow(/not bound/);
    expect(() => getBackendIdForRole("heartbeat")).toThrow(/not bound/);
    expect(() => getBackendLabelForRole("dream")).toThrow(/not bound/);
  });

  it("cleanupBackendPool tears down every pool entry once", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", { cleanupSpy: (id) => cleanups.push(id) }),
    );
    registerBackend(
      makeFactory("beta", "Beta", { cleanupSpy: (id) => cleanups.push(id) }),
    );

    await initBackendPool(configFor("alpha", "beta"), STUB_CTX);
    await cleanupBackendPool();
    // Sort so the assertion is independent of iteration order.
    expect(cleanups.sort()).toEqual(["alpha", "beta"]);
    expect(hasBackendPool()).toBe(false);

    // Idempotent.
    await expect(cleanupBackendPool()).resolves.toBeUndefined();
  });

  it("round-trip rebind reuses + cleans up correctly", async () => {
    const inits: string[] = [];
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    registerBackend(
      makeFactory("beta", "Beta", {
        initSpy: (id) => inits.push(id),
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );

    // Start: chat=alpha (all roles default to alpha)
    await initBackendPool(configFor("alpha"), STUB_CTX);
    expect(inits).toEqual(["alpha"]);

    // chat → beta. alpha still has heartbeat + dream. beta freshly init'd.
    await rebindRole("chat", "beta", configFor("alpha"));
    expect(inits).toEqual(["alpha", "beta"]);
    expect(cleanups).toEqual([]);

    // chat → alpha. beta orphaned → cleanup. alpha reused.
    await rebindRole("chat", "alpha", configFor("alpha"));
    expect(inits).toEqual(["alpha", "beta"]);
    expect(cleanups).toEqual(["beta"]);

    // chat → beta. beta freshly init'd again (was cleaned up previously).
    await rebindRole("chat", "beta", configFor("alpha"));
    expect(inits).toEqual(["alpha", "beta", "beta"]);
    expect(cleanups).toEqual(["beta"]);
  });
});
