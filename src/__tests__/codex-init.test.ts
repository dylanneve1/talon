/**
 * Codex init / ensureCodex tests — verify state-lifecycle invariants
 * around the Codex instance cache.
 *
 * Mocks `@openai/codex-sdk` so we can assert on instance equality
 * without spawning a real subprocess.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Counter so each new Codex gets a unique identity for cache-equality
// assertions.
let CODEX_INSTANCE_COUNTER = 0;
const ORIGINAL_CODEX_API_KEY = process.env.CODEX_API_KEY;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

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

const { ensureCodex, initCodexAgent, codexSubprocessEnv } =
  await import("../backend/codex/init.js");
const { getState, resetState } = await import("../backend/codex/state.js");

beforeEach(() => {
  resetState();
  CODEX_INSTANCE_COUNTER = 0;
  delete process.env.CODEX_API_KEY;
});

afterAll(() => {
  if (ORIGINAL_CODEX_API_KEY === undefined) {
    delete process.env.CODEX_API_KEY;
  } else {
    process.env.CODEX_API_KEY = ORIGINAL_CODEX_API_KEY;
  }
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
});

function withEmptyCodexHome(): () => void {
  const dir = mkdtempSync(join(tmpdir(), "talon-codex-init-"));
  const previousHome = process.env.HOME;
  const previousUserprofile = process.env.USERPROFILE;
  process.env.HOME = dir;
  delete process.env.USERPROFILE;
  return () => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserprofile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserprofile;
    }
    rmSync(dir, { recursive: true, force: true });
  };
}

function withChatGptCodexHome(): () => void {
  const restore = withEmptyCodexHome();
  mkdirSync(join(process.env.HOME!, ".codex"), { recursive: true });
  writeFileSync(
    join(process.env.HOME!, ".codex", "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }),
  );
  return restore;
}

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

  it("uses OPENAI_API_KEY env when config.openaiApiKey and Codex auth file are absent", () => {
    const original = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.TALON_CODEX_KEY;
    const restoreHome = withEmptyCodexHome();
    delete process.env.TALON_CODEX_KEY;
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
      if (originalCodex === undefined) {
        delete process.env.TALON_CODEX_KEY;
      } else {
        process.env.TALON_CODEX_KEY = originalCodex;
      }
      restoreHome();
    }
  });

  it("prefers TALON_CODEX_KEY env over every config key", () => {
    const original = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.TALON_CODEX_KEY;
    process.env.TALON_CODEX_KEY = "codex-env-key";
    process.env.OPENAI_API_KEY = "env-key";
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
          codexApiKey: "codex-config-key",
          openaiApiKey: "config-key",
        } as never,
        () => 19876,
        "telegram",
      );
      const codex = ensureCodex("chatA") as unknown as {
        options: { apiKey?: string };
      };
      expect(codex.options.apiKey).toBe("codex-env-key");
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
      if (originalCodex === undefined) {
        delete process.env.TALON_CODEX_KEY;
      } else {
        process.env.TALON_CODEX_KEY = originalCodex;
      }
    }
  });

  it("prefers config.codexApiKey over OPENAI_API_KEY", () => {
    const original = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.TALON_CODEX_KEY;
    delete process.env.TALON_CODEX_KEY;
    process.env.OPENAI_API_KEY = "env-key";
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
          codexApiKey: "codex-config-key",
          openaiApiKey: "config-key",
        } as never,
        () => 19876,
        "telegram",
      );
      const codex = ensureCodex("chatA") as unknown as {
        options: { apiKey?: string };
      };
      expect(codex.options.apiKey).toBe("codex-config-key");
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = original;
      }
      if (originalCodex === undefined) {
        delete process.env.TALON_CODEX_KEY;
      } else {
        process.env.TALON_CODEX_KEY = originalCodex;
      }
    }
  });

  it("prefers OPENAI_API_KEY env over legacy config.openaiApiKey", () => {
    const original = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.TALON_CODEX_KEY;
    const restoreHome = withEmptyCodexHome();
    delete process.env.TALON_CODEX_KEY;
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
      if (originalCodex === undefined) {
        delete process.env.TALON_CODEX_KEY;
      } else {
        process.env.TALON_CODEX_KEY = originalCodex;
      }
      restoreHome();
    }
  });

  it("falls back to legacy config.openaiApiKey when env and Codex auth file are absent", () => {
    const original = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.TALON_CODEX_KEY;
    const restoreHome = withEmptyCodexHome();
    delete process.env.TALON_CODEX_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
          openaiApiKey: "config-key",
          openaiBaseUrl: "https://api.openai.com/v1",
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
      if (originalCodex !== undefined) {
        process.env.TALON_CODEX_KEY = originalCodex;
      }
      restoreHome();
    }
  });

  it("uses ChatGPT OAuth instead of shared OpenRouter config when logged into Codex", () => {
    const original = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.TALON_CODEX_KEY;
    const restoreHome = withChatGptCodexHome();
    delete process.env.TALON_CODEX_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      initCodexAgent(
        {
          model: "gpt-5-codex",
          workspace: "/tmp",
          systemPrompt: "test",
          frontend: "telegram",
          openaiApiKey: "openrouter-key",
          openaiBaseUrl: "https://openrouter.ai/api/v1",
        } as never,
        () => 19876,
        "telegram",
      );
      const codex = ensureCodex("chatA") as unknown as {
        options: { apiKey?: string; baseUrl?: string };
      };
      expect(codex.options.apiKey).toBeUndefined();
      expect(codex.options.baseUrl).toBeUndefined();
    } finally {
      if (original !== undefined) {
        process.env.OPENAI_API_KEY = original;
      }
      if (originalCodex !== undefined) {
        process.env.TALON_CODEX_KEY = originalCodex;
      }
      restoreHome();
    }
  });
});

describe("codex / subprocess env", () => {
  it("removes broad auth env vars so they cannot shadow the resolved profile", () => {
    const env = codexSubprocessEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CODEX_API_KEY: "stale-codex",
      TALON_CODEX_KEY: "stale-talon",
      OPENAI_API_KEY: "stale-openai",
      OPENAI_BASE_URL: "https://stale.example/v1",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
    });
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
