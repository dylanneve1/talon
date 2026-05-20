/**
 * Codex auth-detection unit tests.
 *
 * Covers `detectCodexAuth` (priority order, file-parse edge cases),
 * `isChatGptModelMismatchError` (substring matching tolerance), and
 * the catalog helpers `isCodexApiKeyOnlyModel` / `chatGptFallbackFor`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import {
  detectCodexAuth,
  resolveCodexApiKey,
  isChatGptModelMismatchError,
} from "../backend/codex/auth.js";
import {
  isCodexApiKeyOnlyModel,
  chatGptFallbackFor,
} from "../backend/codex/models.js";

/**
 * Build a frozen env map that overrides HOME so the file-check path
 * resolves to a test-controlled directory.
 */
function envWith(
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  // Don't inherit the host's OPENAI_API_KEY etc — start from a clean
  // slate so test outcomes don't depend on the caller's shell.
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base;
}

function makeFakeHome(authJson: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "talon-codex-auth-"));
  if (authJson !== null) {
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(join(dir, ".codex", "auth.json"), authJson);
  }
  return dir;
}

describe("codex / detectCodexAuth — priority order", () => {
  it("CODEX_API_KEY wins over every other explicit key", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        codexApiKey: "config-codex-key",
        openaiApiKey: "config-openai-key",
        openaiBaseUrl: "https://proxy.example/v1",
        env: envWith({
          CODEX_API_KEY: "env-upstream-codex-key",
          TALON_CODEX_KEY: "env-codex-key",
          OPENAI_API_KEY: "env-openai-key",
          HOME: fakeHome,
        }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("env:CODEX_API_KEY");
      expect(info.apiKey).toBe("env-upstream-codex-key");
      expect(info.baseUrl).toBe("https://proxy.example/v1");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("TALON_CODEX_KEY wins over config keys and OPENAI_API_KEY", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        codexApiKey: "config-codex-key",
        openaiApiKey: "config-openai-key",
        env: envWith({
          TALON_CODEX_KEY: "env-codex-key",
          OPENAI_API_KEY: "env-openai-key",
          HOME: fakeHome,
        }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("env:TALON_CODEX_KEY");
      expect(info.apiKey).toBe("env-codex-key");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("config codexApiKey wins over OPENAI_API_KEY and the auth file", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        codexApiKey: "from-codex-config",
        openaiApiKey: "from-openai-config",
        env: envWith({ OPENAI_API_KEY: "env-openai-key", HOME: fakeHome }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("config:codexApiKey");
      expect(info.apiKey).toBe("from-codex-config");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("ChatGPT OAuth wins over generic OPENAI_API_KEY and openaiApiKey", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "from-openai-config",
        env: envWith({ OPENAI_API_KEY: "env-openai-key", HOME: fakeHome }),
      });
      expect(info.mode).toBe("chatgpt");
      expect(info.source).toBe("file:~/.codex/auth.json");
      expect(info.apiKey).toBeUndefined();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("uses OPENAI_API_KEY when no Codex auth file exists", () => {
    const fakeHome = makeFakeHome(null);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "from-openai-config",
        env: envWith({ OPENAI_API_KEY: "env-openai-key", HOME: fakeHome }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("env:OPENAI_API_KEY");
      expect(info.apiKey).toBe("env-openai-key");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("uses legacy config openaiApiKey only when no Codex auth file exists", () => {
    const fakeHome = makeFakeHome(`{"auth_mode":"chatgpt"}`);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "from-openai-config",
        openaiBaseUrl: "https://api.openai.com/v1",
        env: envWith({ HOME: fakeHome }),
      });
      expect(info.mode).toBe("chatgpt");
      expect(info.source).toBe("file:~/.codex/auth.json");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("pairs legacy config openaiApiKey with base URL when used as fallback", () => {
    const fakeHome = makeFakeHome(null);
    try {
      const info = detectCodexAuth({
        openaiApiKey: "openrouter-key",
        openaiBaseUrl: "https://openrouter.ai/api/v1",
        env: envWith({ HOME: fakeHome }),
      });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("config:openaiApiKey");
      expect(info.apiKey).toBe("openrouter-key");
      expect(info.baseUrl).toBe("https://openrouter.ai/api/v1");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("falls back to ~/.codex/auth.json chatgpt mode", () => {
    const fakeHome = makeFakeHome(
      `{"auth_mode":"chatgpt","OPENAI_API_KEY":null}`,
    );
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("chatgpt");
      expect(info.source).toBe("file:~/.codex/auth.json");
      expect(info.authFilePath).toBe(join(fakeHome, ".codex", "auth.json"));
      expect(info.authFileParsed).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("auth.json with non-null OPENAI_API_KEY → api-key mode", () => {
    // The codex CLI ships auth.json with `OPENAI_API_KEY` as a
    // top-level field; when non-null it takes precedence over
    // `auth_mode`. This mirrors what the CLI does internally.
    const fakeHome = makeFakeHome(
      `{"auth_mode":"chatgpt","OPENAI_API_KEY":"sk-from-file"}`,
    );
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("api-key");
      expect(info.source).toBe("file:~/.codex/auth.json");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns `none` when no auth source is available", () => {
    const fakeHome = makeFakeHome(null);
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("none");
      expect(info.source).toBe("missing");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns `none` when auth.json exists but doesn't carry a recognised mode", () => {
    const fakeHome = makeFakeHome(`{"some_other_field":"value"}`);
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("none");
      expect(info.authFileParsed).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("surfaces a parse error when auth.json is malformed JSON", () => {
    const fakeHome = makeFakeHome(`{not valid json`);
    try {
      const info = detectCodexAuth({ env: envWith({ HOME: fakeHome }) });
      expect(info.mode).toBe("none");
      expect(info.authFileParsed).toBe(false);
      expect(info.parseError).toBeTruthy();
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("returns `none` when HOME is unset and no other auth is configured", () => {
    const info = detectCodexAuth({ env: envWith({}) });
    expect(info.mode).toBe("none");
    expect(info.authFilePath).toBeUndefined();
  });
});

describe("codex / resolveCodexApiKey", () => {
  it("does not treat shared openaiApiKey config as Codex-specific auth", () => {
    const resolved = resolveCodexApiKey({
      openaiApiKey: "openrouter-key",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      env: envWith({}),
    });
    expect(resolved.apiKey).toBeUndefined();
    expect(resolved.baseUrl).toBeUndefined();
    expect(resolved.source).toBeUndefined();
    expect(resolved.diagnostics).toEqual([]);
  });

  it("accepts explicit Codex key regardless of OpenAI Agents base URL", () => {
    const resolved = resolveCodexApiKey({
      codexApiKey: "codex-key",
      openaiApiKey: "openrouter-key",
      openaiBaseUrl: "https://openrouter.ai/api/v1",
      env: envWith({}),
    });
    expect(resolved.apiKey).toBe("codex-key");
    expect(resolved.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(resolved.source).toBe("config:codexApiKey");
    expect(resolved.diagnostics).toEqual([]);
  });
});

describe("codex / isChatGptModelMismatchError", () => {
  it("matches the canonical OpenAI 400 message", () => {
    expect(
      isChatGptModelMismatchError(
        "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(true);
  });

  it("matches a JSON-wrapped payload", () => {
    const payload = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message:
          "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    expect(isChatGptModelMismatchError(payload)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isChatGptModelMismatchError(
        "NOT SUPPORTED WHEN USING CODEX WITH A CHATGPT ACCOUNT",
      ),
    ).toBe(true);
  });

  it("tolerates extra whitespace", () => {
    expect(
      isChatGptModelMismatchError(
        "not\tsupported  when    using\ncodex   with a chatgpt account",
      ),
    ).toBe(true);
  });

  it("does not match an unrelated 400 error", () => {
    expect(
      isChatGptModelMismatchError(
        "context_length_exceeded: too many tokens in the prompt",
      ),
    ).toBe(false);
  });

  it("does not match a network error", () => {
    expect(isChatGptModelMismatchError("fetch failed — ECONNRESET")).toBe(
      false,
    );
  });
});

describe("codex / api-key-only catalog helpers", () => {
  it("isCodexApiKeyOnlyModel returns true for gpt-5-codex", () => {
    expect(isCodexApiKeyOnlyModel("gpt-5-codex")).toBe(true);
  });

  it("returns false for chatgpt-compatible models", () => {
    expect(isCodexApiKeyOnlyModel("gpt-5.5")).toBe(false);
    expect(isCodexApiKeyOnlyModel("gpt-5")).toBe(false);
    expect(isCodexApiKeyOnlyModel("gpt-5-mini")).toBe(false);
  });

  it("returns false for unknown models (no over-correction)", () => {
    expect(isCodexApiKeyOnlyModel("totally-made-up-model")).toBe(false);
    expect(isCodexApiKeyOnlyModel("")).toBe(false);
  });

  it("chatGptFallbackFor returns gpt-5.5 for gpt-5-codex", () => {
    expect(chatGptFallbackFor("gpt-5-codex")).toBe("gpt-5.5");
  });

  it("chatGptFallbackFor returns undefined for non-api-key-only models", () => {
    expect(chatGptFallbackFor("gpt-5.5")).toBeUndefined();
    expect(chatGptFallbackFor("gpt-5")).toBeUndefined();
    expect(chatGptFallbackFor("unknown-model")).toBeUndefined();
  });
});
