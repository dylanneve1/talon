/**
 * Codex init / ensureCodex tests — verify state-lifecycle invariants
 * around the Codex instance cache.
 *
 * Mocks `@openai/codex-sdk` so we can assert on instance equality
 * without spawning a real subprocess.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Counter so each new Codex gets a unique identity for cache-equality
// assertions.
let CODEX_INSTANCE_COUNTER = 0;

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    instanceId: number;
    constructor(public options: unknown) {
      CODEX_INSTANCE_COUNTER += 1;
      this.instanceId = CODEX_INSTANCE_COUNTER;
    }
    startThread() {
      return {};
    }
    resumeThread() {
      return {};
    }
  },
}));

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
}));

const { ensureCodex, initCodexAgent } =
  await import("../backend/codex/init.js");
const { getState, resetState } = await import("../backend/codex/state.js");

beforeEach(() => {
  resetState();
  CODEX_INSTANCE_COUNTER = 0;
});

describe("codex / ensureCodex caching", () => {
  it("throws if called before initCodexAgent", () => {
    expect(() => ensureCodex("chatA")).toThrow(/not initialized/);
  });

  it("returns the same instance for repeated calls in the same chat", () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const a = ensureCodex("chatA");
    const b = ensureCodex("chatA");
    expect(a).toBe(b);
  });

  it("rebuilds when the chat id changes", () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const a = ensureCodex("chatA");
    const b = ensureCodex("chatB");
    expect(a).not.toBe(b);
    // After the switch, chat B's instance is cached.
    const c = ensureCodex("chatB");
    expect(c).toBe(b);
  });

  it("invalidates the cached instance when initCodexAgent is called again", () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );
    const a = ensureCodex("chatA");

    // Re-initialise (e.g. plugin reload, config swap)
    initCodexAgent(
      {
        model: "gpt-5",
        workspace: "/tmp",
        systemPrompt: "different",
        frontend: "telegram",
      } as never,
      () => 19876,
      "telegram",
    );

    const b = ensureCodex("chatA");
    // Cache was invalidated → b is a fresh instance for the same chat
    expect(a).not.toBe(b);
  });

  it("captures gateway port + frontend label on initCodexAgent", () => {
    initCodexAgent(
      {
        model: "gpt-5-codex",
        workspace: "/tmp",
        systemPrompt: "test",
        frontend: "discord",
      } as never,
      () => 99999,
      "discord",
    );
    const state = getState();
    expect(state.gatewayPortFn()).toBe(99999);
    expect(state.frontendName).toBe("discord");
  });

  it("uses OPENAI_API_KEY env when config.openaiApiKey is absent", () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-key";
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
        } as never,
        () => 19876,
        "telegram",
      );
      const codex = ensureCodex("chatA") as unknown as {
        options: { apiKey?: string };
      };
      expect(codex.options.apiKey).toBe("env-key");
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });

  it("prefers OPENAI_API_KEY env over config.openaiApiKey", () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-key";
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
          openaiApiKey: "config-key",
        } as never,
        () => 19876,
        "telegram",
      );
      const codex = ensureCodex("chatA") as unknown as {
        options: { apiKey?: string };
      };
      // Env wins per the init.ts implementation
      expect(codex.options.apiKey).toBe("env-key");
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });

  it("falls back to config.openaiApiKey when env is absent", () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
          openaiApiKey: "config-key",
        } as never,
        () => 19876,
        "telegram",
      );
      const codex = ensureCodex("chatA") as unknown as {
        options: { apiKey?: string };
      };
      expect(codex.options.apiKey).toBe("config-key");
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_API_KEY = original;
      }
    }
  });
});

describe("codex / initCodexAgent cache invalidation", () => {
  it("clears state.codex on re-init even if config is unchanged", () => {
    const cfg = {
      model: "gpt-5-codex",
      workspace: "/tmp",
      systemPrompt: "test",
      frontend: "telegram",
    } as never;

    initCodexAgent(cfg, () => 19876, "telegram");
    const a = ensureCodex("chatA");

    // Even identical re-init should invalidate (defensive — caller's
    // intent might be "I made some side-effect change like adding a
    // plugin and want a fresh CLI process").
    initCodexAgent(cfg, () => 19876, "telegram");
    const b = ensureCodex("chatA");

    expect(a).not.toBe(b);
  });
});
