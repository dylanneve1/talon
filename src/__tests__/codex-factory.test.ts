/**
 * Codex backend factory tests — verify `init()` produces a composed
 * `Backend` whose capability slots match what Talon's core expects.
 *
 * Stubs out the Codex SDK so the test doesn't spawn a real CLI
 * subprocess.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    startThread() {
      return {};
    }
    resumeThread() {
      return {};
    }
  },
}));

vi.mock("../core/plugin/index.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
}));

const { clearBackends, getBackend, hasBackend } =
  await import("../core/agent-runtime/backend-registry.js");
const { resetState } = await import("../backend/codex/state.js");

beforeAll(async () => {
  // Side-effect import registers the codex factory in the module-scoped
  // registry. Module is cached after the first import, so we only do
  // this once.
  await import("../backend/codex/factory.js");
});

beforeEach(() => {
  // If a previous test cleared the registry, our factory is gone.
  // We can re-register by importing — but the cached module's
  // side-effect ran already. Instead, just don't clear the registry
  // in this test file; the codex factory remains registered for the
  // whole run.
  resetState();
  if (!hasBackend("codex")) {
    // Defensive: if some other test cleared the registry, fall back
    // to a stub factory that mirrors the production shape.
    // (Shouldn't happen in normal test runs.)
    throw new Error(
      "codex backend not registered — did another test clear the registry?",
    );
  }
  void clearBackends; // keep imported for future use
});

describe("codex factory — Backend wiring", () => {
  it("init returns a Backend with the expected capability slots", async () => {
    const factory = getBackend("codex");
    expect(factory).toBeDefined();

    const result = await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
        codexApiKey: "test-key",
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );

    expect(result.backend).toBeDefined();
    expect(result.backend.chat).toBeDefined();
    expect(typeof result.backend.chat?.runChatTurn).toBe("function");
    expect(result.backend.models).toBeDefined();
    expect(typeof result.backend.models?.resolveModelInfo).toBe("function");
    expect(typeof result.backend.models?.getRawModelInfo).toBe("function");
    expect(typeof result.backend.models?.getSettingsPresentation).toBe(
      "function",
    );
    expect(typeof result.backend.models?.getProviders).toBe("function");
    expect(typeof result.backend.models?.getProviderModels).toBe("function");
    expect(typeof result.backend.models?.formatModelError).toBe("function");
    expect(typeof result.backend.models?.listModels).toBe("function");
    expect(result.backend.background).toBeDefined();
    expect(typeof result.backend.background?.runOneShotAgent).toBe("function");
    expect(result.backend.label).toBe("Codex");
  });

  it("resolveModel works through the models slot", async () => {
    const factory = getBackend("codex");
    const { backend } = await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
        codexApiKey: "test-key",
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );

    const resolution = await backend.models!.resolveModelInfo("gpt-5-codex");
    expect(resolution.kind).toBe("exact");
    if (resolution.kind === "exact") {
      expect(resolution.model.id).toBe("gpt-5-codex");
    }
  });

  it("listModels returns the catalog via the models slot", async () => {
    const factory = getBackend("codex");
    const { backend } = await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
        codexApiKey: "test-key",
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );

    const { models, total } = await backend.models!.listModels!();
    expect(total).toBeGreaterThan(0);
    expect(models.some((m: { id: string }) => m.id === "gpt-5-codex")).toBe(
      true,
    );
  });

  it("getProviders returns OpenAI as the sole provider", async () => {
    const factory = getBackend("codex");
    const { backend } = await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );

    const providers = await backend.models!.getProviders!();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("openai");
  });

  it("cleanup hook resets module state for hot-reload", async () => {
    const { getState } = await import("../backend/codex/state.js");
    const factory = getBackend("codex");

    const result = await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
        openaiApiKey: "test-key",
      } as never,
      {
        getBridgePort: () => 19876,
        frontendName: "telegram",
      },
    );

    // After init, state should be populated.
    const stateBefore = getState();
    expect(stateBefore.config).not.toBeNull();
    expect(stateBefore.frontendName).toBe("telegram");

    // Cleanup hook should be callable and reset module state.
    expect(typeof result.cleanup).toBe("function");
    result.cleanup!();

    const stateAfter = getState();
    expect(stateAfter.config).toBeNull();
    expect(stateAfter.codex).toBeNull();
  });

  it("init twice with different config re-populates state without leakage", async () => {
    const { getState } = await import("../backend/codex/state.js");
    const factory = getBackend("codex");

    // First init: discord frontend
    await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "first",
        frontend: "discord",
        openaiApiKey: "key-1",
      } as never,
      {
        getBridgePort: () => 11111,
        frontendName: "discord",
      },
    );
    const stateFirst = getState();
    expect(stateFirst.frontendName).toBe("discord");
    expect(stateFirst.gatewayPortFn()).toBe(11111);

    // Re-init: telegram frontend should fully overwrite.
    await factory!.init(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "second",
        frontend: "telegram",
        openaiApiKey: "key-2",
      } as never,
      {
        getBridgePort: () => 22222,
        frontendName: "telegram",
      },
    );
    const stateSecond = getState();
    expect(stateSecond.frontendName).toBe("telegram");
    expect(stateSecond.gatewayPortFn()).toBe(22222);
    expect(stateSecond.config?.systemPrompt).toBe("second");
  });
});
