/**
 * Tests for the backend controller — hot-swap, listener notification,
 * cleanup ordering, error tolerance.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Backend } from "../core/agent-runtime/capabilities.js";
import { stubBackend } from "./helpers/stub-backend.js";
import type { TalonConfig } from "../util/config.js";
import {
  registerBackend,
  clearBackends,
  type BackendFactory,
} from "../backend/registry.js";
import {
  initBackendController,
  getActiveBackend,
  getActiveBackendId,
  getActiveBackendLabel,
  getActiveBackendOrNull,
  hasActiveBackend,
  switchBackend,
  listAvailableBackends,
  isBackendAvailable,
  isModelValidForBackend,
  onBackendChange,
  cleanupBackendController,
  resetBackendControllerForTest,
  clearBackendChangeListenersForTest,
} from "../core/engine/backend-controller.js";

function makeStubBackend(label: string): Backend {
  return stubBackend({
    label,
    query: vi.fn(async () => ({
      text: `[${label}] reply`,
      durationMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })),
  });
}

function makeFactory(
  id: string,
  label: string,
  opts: {
    failInit?: boolean;
    cleanupSpy?: (id: string) => void;
    initSpy?: (id: string) => void;
    backend?: Backend;
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
      const backend = opts.backend ?? makeStubBackend(label);
      return {
        backend,
        cleanup: () => {
          opts.cleanupSpy?.(id);
        },
      };
    },
  };
}

const STUB_CONFIG = { backend: "alpha" } as unknown as TalonConfig;
const STUB_CTX = {
  getBridgePort: () => 0,
  frontendName: "terminal" as const,
};

beforeEach(async () => {
  await cleanupBackendController();
  resetBackendControllerForTest();
  clearBackendChangeListenersForTest();
  clearBackends();
});

describe("backend-controller", () => {
  it("initialises with a registered backend", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    expect(hasActiveBackend()).toBe(false);

    const backend = await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    expect(hasActiveBackend()).toBe(true);
    expect(getActiveBackendId()).toBe("alpha");
    expect(getActiveBackendLabel()).toBe("Alpha");
    expect(getActiveBackend()).toBe(backend);
    expect(getActiveBackendOrNull()).toBe(backend);
  });

  it("throws when initialising an unknown backend", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await expect(
      initBackendController("ghost", STUB_CONFIG, STUB_CTX),
    ).rejects.toThrow(/Unknown backend/);
  });

  it("getActiveBackend throws if controller not initialised", () => {
    expect(() => getActiveBackend()).toThrow(/not initialised/);
    expect(() => getActiveBackendId()).toThrow(/not initialised/);
    expect(() => getActiveBackendLabel()).toThrow(/not initialised/);
    expect(getActiveBackendOrNull()).toBeNull();
  });

  it("hot-swaps to a different backend", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(`cleanup:${id}`),
      }),
    );
    registerBackend(makeFactory("beta", "Beta"));

    const alpha = await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    expect(getActiveBackend()).toBe(alpha);

    const result = await switchBackend("beta", STUB_CONFIG);
    expect(result).toMatchObject({ ok: true, from: "alpha", to: "beta" });
    expect(getActiveBackendId()).toBe("beta");
    expect(getActiveBackend()).not.toBe(alpha);
    expect(cleanups).toEqual(["cleanup:alpha"]);
  });

  it("rejects same-id swap", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    const result = await switchBackend("alpha", STUB_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Already on/);
  });

  it("rejects swap to unknown backend with helpful error", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    const result = await switchBackend("gamma", STUB_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown backend "gamma"/);
    expect(result.error).toMatch(/"alpha"/);
    expect(result.error).toMatch(/"beta"/);
  });

  it("keeps previous backend active when new backend init fails", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(`cleanup:${id}`),
      }),
    );
    registerBackend(makeFactory("beta", "Beta", { failInit: true }));

    const alpha = await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    const result = await switchBackend("beta", STUB_CONFIG);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Failed to init Beta/);
    expect(getActiveBackend()).toBe(alpha);
    expect(getActiveBackendId()).toBe("alpha");
    expect(cleanups).toEqual([]); // previous cleanup must not have fired
  });

  it("survives cleanup failure on previous backend", async () => {
    registerBackend({
      id: "alpha",
      label: "Alpha",
      async init() {
        return {
          backend: makeStubBackend("Alpha"),
          cleanup: () => {
            throw new Error("cleanup boom");
          },
        };
      },
    });
    registerBackend(makeFactory("beta", "Beta"));

    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    const result = await switchBackend("beta", STUB_CONFIG);
    expect(result.ok).toBe(true);
    expect(getActiveBackendId()).toBe("beta");
  });

  it("notifies listeners after a successful swap", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    const calls: Array<{ id: string; label: string }> = [];
    onBackendChange((_role, _b, info) => {
      calls.push(info);
    });

    await switchBackend("beta", STUB_CONFIG);
    expect(calls).toEqual([{ id: "beta", label: "Beta" }]);
  });

  it("does not notify listeners on failed swap (init error)", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta", { failInit: true }));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    const calls: Array<{ id: string }> = [];
    onBackendChange((_role, _b, info) => calls.push({ id: info.id }));

    await switchBackend("beta", STUB_CONFIG);
    expect(calls).toEqual([]);
  });

  it("listener errors do not block subsequent listeners", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    const second = vi.fn();
    onBackendChange(() => {
      throw new Error("first listener boom");
    });
    onBackendChange(second);

    await switchBackend("beta", STUB_CONFIG);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("listener unsubscribe stops future notifications", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));
    registerBackend(makeFactory("gamma", "Gamma"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    const calls: string[] = [];
    const unsubscribe = onBackendChange((_role, _b, info) =>
      calls.push(info.id),
    );

    await switchBackend("beta", STUB_CONFIG);
    unsubscribe();
    await switchBackend("gamma", STUB_CONFIG);

    expect(calls).toEqual(["beta"]);
  });

  it("listAvailableBackends sorts by id and reports labels", async () => {
    registerBackend(makeFactory("kilo", "Kilo"));
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("codex", "Codex"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    expect(listAvailableBackends()).toEqual([
      { id: "alpha", label: "Alpha" },
      { id: "codex", label: "Codex" },
      { id: "kilo", label: "Kilo" },
    ]);
  });

  it("isBackendAvailable respects enabledBackends", () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    registerBackend(makeFactory("beta", "Beta"));

    expect(isBackendAvailable("alpha")).toBe(true);
    expect(
      isBackendAvailable("alpha", {
        enabledBackends: ["beta"],
      } as unknown as TalonConfig),
    ).toBe(false);
    expect(
      isBackendAvailable("beta", {
        enabledBackends: ["beta"],
      } as unknown as TalonConfig),
    ).toBe(true);
    expect(isBackendAvailable("ghost")).toBe(false);
  });

  it("isModelValidForBackend trusts an exact selectable resolveModelInfo result", async () => {
    const backend = stubBackend({
      label: "Alpha",
      resolveModel: vi.fn(async (query: string) => {
        if (query === "good") {
          return {
            kind: "exact" as const,
            storedValue: "good",
            model: {
              id: "good",
              displayName: "Good",
              provider: "test",
              providerName: "Test",
              selectable: true,
            },
          };
        }
        if (query === "hidden") {
          return {
            kind: "exact" as const,
            storedValue: "hidden",
            model: {
              id: "hidden",
              displayName: "Hidden",
              provider: "test",
              providerName: "Test",
              selectable: false,
            },
          };
        }
        return { kind: "missing" as const };
      }),
    });

    await expect(isModelValidForBackend(backend, "good")).resolves.toBe(true);
    await expect(isModelValidForBackend(backend, "hidden")).resolves.toBe(
      false,
    );
    await expect(isModelValidForBackend(backend, "missing")).resolves.toBe(
      false,
    );
  });

  it("round-trip swap reuses the registry factory each time", async () => {
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

    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    await switchBackend("beta", STUB_CONFIG);
    await switchBackend("alpha", STUB_CONFIG);
    await switchBackend("beta", STUB_CONFIG);

    // 4 inits: initial alpha, switch to beta, switch back to alpha,
    // switch to beta again. Each switch fully reinitialises the
    // target backend — no stale state cached across cycles.
    expect(inits).toEqual(["alpha", "beta", "alpha", "beta"]);
    // 3 cleanups: leaving alpha (1st), leaving beta (2nd), leaving
    // alpha (3rd). The final beta is still active.
    expect(cleanups).toEqual(["alpha", "beta", "alpha"]);
  });

  it("cleanupBackendController invokes cleanup and clears state", async () => {
    const cleanups: string[] = [];
    registerBackend(
      makeFactory("alpha", "Alpha", {
        cleanupSpy: (id) => cleanups.push(id),
      }),
    );
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);

    await cleanupBackendController();
    expect(cleanups).toEqual(["alpha"]);
    expect(hasActiveBackend()).toBe(false);
    expect(getActiveBackendOrNull()).toBeNull();
  });

  it("cleanupBackendController is idempotent", async () => {
    registerBackend(makeFactory("alpha", "Alpha"));
    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    await cleanupBackendController();
    await expect(cleanupBackendController()).resolves.toBeUndefined();
  });

  it("hot-swap accessor returns the new backend before cleanup completes", async () => {
    // Deliberately slow cleanup to verify reads see the new backend
    // before the previous one has finished tearing down.
    let cleanupResolve!: () => void;
    const cleanupPromise = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });
    registerBackend({
      id: "alpha",
      label: "Alpha",
      async init() {
        return {
          backend: makeStubBackend("Alpha"),
          cleanup: async () => {
            await cleanupPromise;
          },
        };
      },
    });
    registerBackend(makeFactory("beta", "Beta"));

    await initBackendController("alpha", STUB_CONFIG, STUB_CTX);
    const swapPromise = switchBackend("beta", STUB_CONFIG);

    // Give the swap a microtask to flip the active pointer.
    await new Promise((r) => setImmediate(r));
    expect(getActiveBackendId()).toBe("beta");

    // Now release the old cleanup and await the swap.
    cleanupResolve();
    const result = await swapPromise;
    expect(result.ok).toBe(true);
  });
});
