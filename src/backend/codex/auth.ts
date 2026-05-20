/**
 * Codex authentication detection.
 *
 * The Codex CLI supports two distinct authentication modes, with
 * materially different capabilities:
 *
 *   - **API key** (`CODEX_API_KEY` / `TALON_CODEX_KEY` env var,
 *     `codexApiKey` passed to the SDK's `Codex` constructor, or
 *     `OPENAI_API_KEY` stored in `~/.codex/auth.json`). Full model
 *     catalog access, billed via the configured OpenAI-compatible API.
 *     `gpt-5-codex` is the flagship on OpenAI's native endpoint.
 *
 *   - **ChatGPT OAuth** (`~/.codex/auth.json` `auth_mode: "chatgpt"`
 *     after running `codex login`). Restricted to a subset of models —
 *     `gpt-5-codex` is explicitly rejected with a 400
 *     "invalid_request_error" telling the user the model isn't
 *     supported on a ChatGPT account. `gpt-5.5` is the flagship under
 *     this auth mode.
 *
 * Talon needs to know which mode is active at startup so it can pick a
 * sensible default model and surface useful errors. This module owns
 * the detection logic.
 *
 * Detection order (each step short-circuits if it succeeds):
 *
 *   1. `CODEX_API_KEY` env var → `"api-key"` (Codex CLI convention).
 *   2. `TALON_CODEX_KEY` env var → `"api-key"` (Talon-scoped alias).
 *   3. `codexApiKey` in Talon config → `"api-key"`.
 *      Any Codex-specific API key is paired with `openaiBaseUrl` when
 *      configured; the SDK maps that to Codex's `openai_base_url`
 *      override.
 *   4. `~/.codex/auth.json` exists + `auth_mode` field is read → returns
 *      that value (`"chatgpt"` for OAuth, `"api-key"` if the JSON also
 *      has a non-null `OPENAI_API_KEY`).
 *   5. `OPENAI_API_KEY` env var → `"api-key"` as a generic fallback.
 *   6. `openaiApiKey` in Talon config → `"api-key"` as a legacy fallback.
 *      These shared OpenAI credentials are deliberately after the Codex
 *      auth file so other Talon backends can keep their credentials
 *      without hijacking a logged-in Codex CLI.
 *   7. Nothing → `"none"`. First turn will fail with an auth error;
 *      caller emits a startup warning pointing to `codex login`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Detected auth mode. */
export type CodexAuthMode = "api-key" | "chatgpt" | "none";

export type CodexApiKeySource =
  | "env:CODEX_API_KEY"
  | "env:TALON_CODEX_KEY"
  | "config:codexApiKey"
  | "env:OPENAI_API_KEY"
  | "config:openaiApiKey";

/** Resolved auth state plus diagnostics for the startup log. */
export interface CodexAuthInfo {
  mode: CodexAuthMode;
  /** Where the credential was found, for logging. */
  source: CodexApiKeySource | "file:~/.codex/auth.json" | "missing";
  /** API key to pass into the Codex SDK, when auth is explicit. */
  apiKey?: string;
  /** Base URL to pass into the Codex SDK alongside explicit API-key auth. */
  baseUrl?: string;
  /** Path to the auth file when present (for diagnostics). */
  authFilePath?: string;
  /** Whether the auth file (if present) parsed correctly. */
  authFileParsed: boolean;
  /** Raw parse error when the file existed but couldn't be parsed. */
  parseError?: string;
  /** Diagnostics about credential resolution. */
  diagnostics: string[];
}

export interface DetectCodexAuthInput {
  codexApiKey?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function normalizeCodexBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function resolveCodexApiKey(input: DetectCodexAuthInput): {
  apiKey?: string;
  baseUrl?: string;
  source?: CodexApiKeySource;
  diagnostics: string[];
} {
  const env = input.env ?? process.env;
  const baseUrl = normalizeCodexBaseUrl(input.openaiBaseUrl);
  const diagnostics: string[] = [];

  const codexApiKeyEnv = normalizeSecret(env.CODEX_API_KEY);
  if (codexApiKeyEnv) {
    return {
      apiKey: codexApiKeyEnv,
      baseUrl,
      source: "env:CODEX_API_KEY",
      diagnostics,
    };
  }

  const talonCodexKeyEnv = normalizeSecret(env.TALON_CODEX_KEY);
  if (talonCodexKeyEnv) {
    return {
      apiKey: talonCodexKeyEnv,
      baseUrl,
      source: "env:TALON_CODEX_KEY",
      diagnostics,
    };
  }

  const configCodexApiKey = normalizeSecret(input.codexApiKey);
  if (configCodexApiKey) {
    return {
      apiKey: configCodexApiKey,
      baseUrl,
      source: "config:codexApiKey",
      diagnostics,
    };
  }

  return { diagnostics };
}

function resolveGenericOpenAiApiKey(input: DetectCodexAuthInput): {
  apiKey?: string;
  baseUrl?: string;
  source?: Extract<
    CodexApiKeySource,
    "env:OPENAI_API_KEY" | "config:openaiApiKey"
  >;
  diagnostics: string[];
} {
  const env = input.env ?? process.env;
  const baseUrl = normalizeCodexBaseUrl(input.openaiBaseUrl);
  const diagnostics: string[] = [];

  const openAiApiKeyEnv = normalizeSecret(env.OPENAI_API_KEY);
  if (openAiApiKeyEnv) {
    return {
      apiKey: openAiApiKeyEnv,
      baseUrl,
      source: "env:OPENAI_API_KEY",
      diagnostics,
    };
  }

  const configOpenAiApiKey = normalizeSecret(input.openaiApiKey);
  if (configOpenAiApiKey) {
    return {
      apiKey: configOpenAiApiKey,
      baseUrl,
      source: "config:openaiApiKey",
      diagnostics,
    };
  }

  return { diagnostics };
}

/**
 * Detect the active Codex auth mode.
 *
 * All config values are passed in by the caller so this module doesn't
 * depend on the config module.
 */
export function detectCodexAuth(
  input: DetectCodexAuthInput = {},
): CodexAuthInfo {
  const env = input.env ?? process.env;
  const explicitKey = resolveCodexApiKey(input);
  if (explicitKey.apiKey && explicitKey.source) {
    return {
      mode: "api-key",
      source: explicitKey.source,
      apiKey: explicitKey.apiKey,
      baseUrl: explicitKey.baseUrl,
      authFileParsed: false,
      diagnostics: explicitKey.diagnostics,
    };
  }

  let authFileResult: CodexAuthInfo | null = null;
  // Codex CLI auth file (created by `codex login`).
  const home = env.HOME ?? env.USERPROFILE;
  if (home) {
    const authFilePath = join(home, ".codex", "auth.json");
    if (existsSync(authFilePath)) {
      try {
        const raw = readFileSync(authFilePath, "utf8");
        const parsed = JSON.parse(raw) as {
          auth_mode?: string;
          OPENAI_API_KEY?: string | null;
        };
        // The auth.json schema includes `OPENAI_API_KEY` as a top-level
        // field even on ChatGPT-mode installs; when it's non-null it
        // takes precedence (mirrors what the CLI itself does).
        const fileApiKey =
          typeof parsed.OPENAI_API_KEY === "string"
            ? normalizeSecret(parsed.OPENAI_API_KEY)
            : undefined;
        if (fileApiKey) {
          return {
            mode: "api-key",
            source: "file:~/.codex/auth.json",
            apiKey: fileApiKey,
            authFilePath,
            authFileParsed: true,
            diagnostics: explicitKey.diagnostics,
          };
        }
        if (parsed.auth_mode === "chatgpt") {
          return {
            mode: "chatgpt",
            source: "file:~/.codex/auth.json",
            authFilePath,
            authFileParsed: true,
            diagnostics: explicitKey.diagnostics,
          };
        }
        // File parsed but doesn't carry a recognised mode — treat as
        // missing for now; generic OpenAI fallback may still be usable.
        authFileResult = {
          mode: "none",
          source: "missing",
          authFilePath,
          authFileParsed: true,
          diagnostics: explicitKey.diagnostics,
        };
      } catch (err) {
        authFileResult = {
          mode: "none",
          source: "missing",
          authFilePath,
          authFileParsed: false,
          parseError: err instanceof Error ? err.message : String(err),
          diagnostics: explicitKey.diagnostics,
        };
      }
    }
  }

  const genericKey = resolveGenericOpenAiApiKey(input);
  if (genericKey.apiKey && genericKey.source) {
    return {
      mode: "api-key",
      source: genericKey.source,
      apiKey: genericKey.apiKey,
      baseUrl: genericKey.baseUrl,
      authFileParsed: authFileResult?.authFileParsed ?? false,
      authFilePath: authFileResult?.authFilePath,
      parseError: authFileResult?.parseError,
      diagnostics: [...explicitKey.diagnostics, ...genericKey.diagnostics],
    };
  }

  if (authFileResult) return authFileResult;

  // Nothing.
  return {
    mode: "none",
    source: "missing",
    authFileParsed: false,
    diagnostics: explicitKey.diagnostics,
  };
}

/**
 * Detect whether an error from `runStreamed` is the
 * "model-not-supported-on-ChatGPT-account" 400. Used by the handler's
 * recovery ladder to auto-fall-back to a ChatGPT-compatible model when
 * the configured one is API-key-only.
 *
 * Codex surfaces this in two places — the JSON error payload nested
 * inside an `error` event, AND the textual `turn.failed.error.message`
 * the SDK wraps around it. Both contain the substring
 * `"not supported when using Codex with a ChatGPT account"`. Match on
 * that substring (case-insensitive, generous on whitespace) so a
 * future wording shift still trips a soft-match.
 */
export function isChatGptModelMismatchError(message: string): boolean {
  return /not\s+supported\s+when\s+using\s+codex\s+with\s+a\s+chatgpt\s+account/i.test(
    message,
  );
}
