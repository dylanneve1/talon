/**
 * Antigravity backend factory tests — verify `init()` produces a
 * QueryBackend with the full surface area Talon's core expects.
 *
 * Does NOT spawn the Python bridge — `init` only ensures workspace
 * dirs + stashes config; bridges spawn lazily in the handler.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
}));

const { clearBackends, getBackend, hasBackend } =
  await import("../backend/registry.js");
const { resetState } = await import("../backend/antigravity/state.js");

beforeAll(async () => {
  await import("../backend/antigravity/factory.js");
});

beforeEach(async () => {
  await resetState();
  if (!hasBackend("antigravity")) {
    throw new Error(
      "antigravity backend not registered — did another test clear the registry?",
    );
  }
  void clearBackends;
});

describe("antigravity factory — QueryBackend wiring", () => {
  it("init returns a QueryBackend with all expected methods", async () => {
    const factory = getBackend("antigravity");
    expect(factory).toBeDefined();

    const result = await factory!.init(
      {
        // Minimal valid Talon config
        frontend: "telegram",
        backend: "antigravity",
        model: "default",
        concurrency: 1,
        pulse: false,
        pulseIntervalMs: 60_000,
        heartbeat: false,
        heartbeatIntervalMinutes: 60,
        maxMessageLength: 4000,
        plugins: [],
        // Antigravity-specific
        geminiApiKey: "test-key",
        antigravityWorkspace: "/tmp/talon-ag-test-workspace",
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );

    expect(result.backend).toBeDefined();
    expect(typeof result.backend.query).toBe("function");
    expect(typeof result.backend.resolveModel).toBe("function");
    expect(typeof result.backend.getModelInfo).toBe("function");
    expect(typeof result.backend.getSettingsPresentation).toBe("function");
    expect(typeof result.backend.getProviders).toBe("function");
    expect(typeof result.backend.getProviderModels).toBe("function");
    expect(typeof result.backend.formatModelError).toBe("function");
    expect(typeof result.backend.listModels).toBe("function");
    expect(typeof result.backend.runOneShotAgent).toBe("function");
    expect(result.backend.backendLabel).toBe("Antigravity");
    expect(typeof result.cleanup).toBe("function");
  });

  it("factory has the expected id and label", () => {
    const factory = getBackend("antigravity");
    expect(factory?.id).toBe("antigravity");
    expect(factory?.label).toBe("Antigravity");
  });

  it("resolveModel routes to the catalog", async () => {
    const factory = getBackend("antigravity");
    const result = await factory!.init(
      {
        frontend: "telegram",
        backend: "antigravity",
        model: "default",
        concurrency: 1,
        pulse: false,
        pulseIntervalMs: 60_000,
        heartbeat: false,
        heartbeatIntervalMinutes: 60,
        maxMessageLength: 4000,
        plugins: [],
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );
    const resolved = await result.backend.resolveModel!("gemini-3.5-flash");
    expect(resolved.kind).toBe("exact");
  });

  it("cleanup is idempotent (state can be reset twice)", async () => {
    const factory = getBackend("antigravity");
    const result = await factory!.init(
      {
        frontend: "telegram",
        backend: "antigravity",
        model: "default",
        concurrency: 1,
        pulse: false,
        pulseIntervalMs: 60_000,
        heartbeat: false,
        heartbeatIntervalMinutes: 60,
        maxMessageLength: 4000,
        plugins: [],
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );
    await result.cleanup?.();
    await result.cleanup?.();
    // No assertion — just verifying the second call doesn't throw.
    expect(true).toBe(true);
  });
});
