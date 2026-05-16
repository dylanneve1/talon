/**
 * Codex authentication detection.
 *
 * The Codex CLI supports two distinct authentication modes, with
 * materially different capabilities:
 *
 *   - **API key** (`OPENAI_API_KEY` env var, or `apiKey` passed to the
 *     SDK's `Codex` constructor, or `OPENAI_API_KEY` stored in
 *     `~/.codex/auth.json`). Full model catalog access, billed via the
 *     standard OpenAI API. `gpt-5-codex` is the flagship.
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
 *   1. `OPENAI_API_KEY` env var → `"api-key"`.
 *   2. `openaiApiKey` in Talon config → `"api-key"`.
 *   3. `~/.codex/auth.json` exists + `auth_mode` field is read → returns
 *      that value (`"chatgpt"` for OAuth, `"api-key"` if the JSON also
 *      has a non-null `OPENAI_API_KEY`).
 *   4. Nothing → `"none"`. First turn will fail with an auth error;
 *      caller emits a startup warning pointing to `codex login`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Detected auth mode. */
export type CodexAuthMode = "api-key" | "chatgpt" | "none";

/** Resolved auth state plus diagnostics for the startup log. */
export interface CodexAuthInfo {
  mode: CodexAuthMode;
  /** Where the credential was found, for logging. */
  source:
    | "env:OPENAI_API_KEY"
    | "config:openaiApiKey"
    | "file:~/.codex/auth.json"
    | "missing";
  /** Path to the auth file when present (for diagnostics). */
  authFilePath?: string;
  /** Whether the auth file (if present) parsed correctly. */
  authFileParsed: boolean;
  /** Raw parse error when the file existed but couldn't be parsed. */
  parseError?: string;
}

/**
 * Detect the active Codex auth mode.
 *
 * `configKey` is the value of `config.openaiApiKey` from Talon's main
 * config — passed in by the caller so this module doesn't depend on
 * the config module. `envOverride` defaults to `process.env` so tests
 * can substitute a frozen env map.
 */
export function detectCodexAuth(
  configKey?: string,
  envOverride: NodeJS.ProcessEnv = process.env,
): CodexAuthInfo {
  // 1. Explicit API key in the environment.
  if (envOverride.OPENAI_API_KEY) {
    return {
      mode: "api-key",
      source: "env:OPENAI_API_KEY",
      authFileParsed: false,
    };
  }

  // 2. Explicit API key in Talon's config.
  if (configKey) {
    return {
      mode: "api-key",
      source: "config:openaiApiKey",
      authFileParsed: false,
    };
  }

  // 3. Codex CLI auth file (created by `codex login`).
  const home = envOverride.HOME ?? envOverride.USERPROFILE;
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
        if (
          parsed.OPENAI_API_KEY &&
          typeof parsed.OPENAI_API_KEY === "string"
        ) {
          return {
            mode: "api-key",
            source: "file:~/.codex/auth.json",
            authFilePath,
            authFileParsed: true,
          };
        }
        if (parsed.auth_mode === "chatgpt") {
          return {
            mode: "chatgpt",
            source: "file:~/.codex/auth.json",
            authFilePath,
            authFileParsed: true,
          };
        }
        // File parsed but doesn't carry a recognised mode — treat as
        // missing so the caller surfaces a `codex login` reminder.
        return {
          mode: "none",
          source: "missing",
          authFilePath,
          authFileParsed: true,
        };
      } catch (err) {
        return {
          mode: "none",
          source: "missing",
          authFilePath,
          authFileParsed: false,
          parseError: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // 4. Nothing.
  return {
    mode: "none",
    source: "missing",
    authFileParsed: false,
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
