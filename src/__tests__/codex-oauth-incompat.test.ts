/**
 * Codex OAuth-incompat runtime learning store tests.
 *
 * Covers `oauth-incompat.ts` (persistence round-trip, fingerprint
 * matching, malformed-file tolerance), `models.isCodexOAuthIncompat`
 * (combined curated + dynamic check), `models.chatGptFallbackFor`
 * (broadened fallback selection), and `auth.isSilentOAuthExitError`
 * (the 2026-05-20 Pandario regression pattern).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  computeAuthFingerprint,
  isKnownOAuthIncompat,
  loadOAuthIncompatStore,
  markOAuthIncompat,
  listKnownOAuthIncompat,
  resetOAuthIncompatForTests,
} from "../backend/codex/oauth-incompat.js";
import {
  isCodexApiKeyOnlyModel,
  isCodexOAuthIncompat,
  chatGptFallbackFor,
} from "../backend/codex/models.js";
import {
  isSilentOAuthExitError,
  isChatGptModelMismatchError,
  type CodexAuthInfo,
} from "../backend/codex/auth.js";
// `oauth-incompat.ts` resolves the store path lazily against
// `homedir()` at every call, so overriding HOME in `beforeEach`
// fully isolates each test under a temp directory. No need to touch
// the production `~/.talon/data/codex-oauth-incompat.json` path —
// nothing in this file should ever resolve to it.

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let tempHome: string;

/**
 * Compute the per-test store path the same way `oauth-incompat.ts`
 * does — `<tempHome>/.talon/data/codex-oauth-incompat.json`. Used by
 * tests that need to seed the store before calling
 * `loadOAuthIncompatStore`.
 */
function testStorePath(): string {
  return join(tempHome, ".talon", "data", "codex-oauth-incompat.json");
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  tempHome = mkdtempSync(join(tmpdir(), "talon-codex-incompat-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  resetOAuthIncompatForTests();
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserProfile !== undefined) {
    process.env.USERPROFILE = originalUserProfile;
  } else {
    delete process.env.USERPROFILE;
  }
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  resetOAuthIncompatForTests();
});

// ── Fingerprint computation ────────────────────────────────────────────────

describe("computeAuthFingerprint", () => {
  it("chatgpt mode uses mode + source only (no token to hash)", () => {
    const info: CodexAuthInfo = {
      mode: "chatgpt",
      source: "file:~/.codex/auth.json",
      authFileParsed: true,
      diagnostics: [],
    };
    expect(computeAuthFingerprint(info)).toBe(
      "chatgpt:file:~/.codex/auth.json",
    );
  });

  it("api-key mode includes a short prefix of the key for differentiation", () => {
    const a: CodexAuthInfo = {
      mode: "api-key",
      source: "env:CODEX_API_KEY",
      apiKey: "sk-key-A-0123456789abcdef-rest-of-secret-here",
      authFileParsed: false,
      diagnostics: [],
    };
    const b: CodexAuthInfo = {
      mode: "api-key",
      source: "env:CODEX_API_KEY",
      apiKey: "sk-key-B-0123456789abcdef-rest-of-secret-here",
      authFileParsed: false,
      diagnostics: [],
    };
    expect(computeAuthFingerprint(a)).not.toBe(computeAuthFingerprint(b));
    expect(computeAuthFingerprint(a)).toContain("api-key:env:CODEX_API_KEY:");
  });

  it("none mode returns a deterministic missing fingerprint", () => {
    const info: CodexAuthInfo = {
      mode: "none",
      source: "missing",
      authFileParsed: false,
      diagnostics: [],
    };
    expect(computeAuthFingerprint(info)).toBe("none:missing");
  });
});

// ── Load + mark round-trip ────────────────────────────────────────────────

describe("oauth-incompat / persistence", () => {
  it("returns empty when no store file exists", async () => {
    await loadOAuthIncompatStore("chatgpt:file:~/.codex/auth.json");
    expect(isKnownOAuthIncompat("gpt-5.4-mini")).toBe(false);
    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("mark + reload round-trips the set", async () => {
    const fingerprint = "chatgpt:file:~/.codex/auth.json";
    await loadOAuthIncompatStore(fingerprint);

    expect(await markOAuthIncompat("gpt-5.4-mini")).toBe(true);
    expect(await markOAuthIncompat("gpt-5.4")).toBe(true);
    // Second mark of same id is a no-op:
    expect(await markOAuthIncompat("gpt-5.4-mini")).toBe(false);

    expect(isKnownOAuthIncompat("gpt-5.4-mini")).toBe(true);
    expect(isKnownOAuthIncompat("gpt-5.4")).toBe(true);
    expect(isKnownOAuthIncompat("gpt-5.5")).toBe(false);
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4", "gpt-5.4-mini"]);

    // Simulate restart: blow away in-memory state and reload.
    resetOAuthIncompatForTests();
    await loadOAuthIncompatStore(fingerprint);
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
  });

  it("fingerprint mismatch discards the loaded set", async () => {
    await loadOAuthIncompatStore("chatgpt:file:~/.codex/auth.json");
    await markOAuthIncompat("gpt-5.4-mini");
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4-mini"]);

    // Simulate `codex login` with a different account / mode.
    resetOAuthIncompatForTests();
    await loadOAuthIncompatStore("api-key:env:CODEX_API_KEY:sk-different");
    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("tolerates a malformed JSON store gracefully", async () => {
    mkdirSync(join(testStorePath(), ".."), { recursive: true });
    writeFileSync(testStorePath(), "not json at all { } {");
    await loadOAuthIncompatStore("chatgpt:test");
    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("tolerates a schema-version mismatch", async () => {
    // The store path resolves against `tempHome` (see beforeEach).
    mkdirSync(join(testStorePath(), ".."), { recursive: true });
    writeFileSync(
      testStorePath(),
      JSON.stringify({
        version: 999,
        fingerprint: "chatgpt:test",
        updatedAt: new Date().toISOString(),
        models: ["gpt-5.4-mini"],
      }),
    );
    await loadOAuthIncompatStore("chatgpt:test");
    expect(listKnownOAuthIncompat()).toEqual([]);
  });

  it("filters non-string entries on load (defensive)", async () => {
    // The store path resolves against `tempHome` (see beforeEach).
    mkdirSync(join(testStorePath(), ".."), { recursive: true });
    writeFileSync(
      testStorePath(),
      JSON.stringify({
        version: 1,
        fingerprint: "chatgpt:test",
        updatedAt: new Date().toISOString(),
        models: ["gpt-5.4-mini", null, 42, "", "gpt-5.2"],
      }),
    );
    await loadOAuthIncompatStore("chatgpt:test");
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.2", "gpt-5.4-mini"]);
  });

  it("markOAuthIncompat is a safe no-op when no store is loaded", async () => {
    resetOAuthIncompatForTests();
    expect(await markOAuthIncompat("gpt-5.4-mini")).toBe(false);
    expect(isKnownOAuthIncompat("gpt-5.4-mini")).toBe(false);
  });

  it("migrates legacy bare-document format to the new envelope shape", async () => {
    // Write data in the pre-Phase-6.x shape and verify the migrate
    // hook lifts it into the envelope on load.
    mkdirSync(join(testStorePath(), ".."), { recursive: true });
    writeFileSync(
      testStorePath(),
      JSON.stringify({
        version: 1,
        fingerprint: "chatgpt:test",
        updatedAt: new Date().toISOString(),
        models: ["gpt-5.4-mini", "gpt-5.4"],
      }),
    );
    await loadOAuthIncompatStore("chatgpt:test");
    expect(listKnownOAuthIncompat()).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
  });
});

// ── Combined predicate: curated ∪ dynamic ────────────────────────────────

describe("isCodexOAuthIncompat — combined curated + dynamic", () => {
  beforeEach(async () => {
    await loadOAuthIncompatStore("chatgpt:test");
  });

  it("returns true for curated apiKeyOnly entries even without learning", () => {
    expect(isCodexApiKeyOnlyModel("gpt-5-codex")).toBe(true);
    expect(isCodexOAuthIncompat("gpt-5-codex")).toBe(true);
  });

  it("returns true for runtime-learned ids even when not curated", async () => {
    expect(isCodexApiKeyOnlyModel("gpt-5.4-mini")).toBe(false);
    expect(isCodexOAuthIncompat("gpt-5.4-mini")).toBe(false);

    await markOAuthIncompat("gpt-5.4-mini");
    expect(isCodexOAuthIncompat("gpt-5.4-mini")).toBe(true);
    // Curated check stays narrow:
    expect(isCodexApiKeyOnlyModel("gpt-5.4-mini")).toBe(false);
  });

  it("returns false for known-good models (gpt-5.5)", async () => {
    expect(isCodexOAuthIncompat("gpt-5.5")).toBe(false);
    await markOAuthIncompat("gpt-5.4-mini"); // unrelated mark
    expect(isCodexOAuthIncompat("gpt-5.5")).toBe(false);
  });
});

// ── chatGptFallbackFor — broadened ────────────────────────────────────────

describe("chatGptFallbackFor — broadened fallback selection", () => {
  beforeEach(async () => {
    await loadOAuthIncompatStore("chatgpt:test");
  });

  it("returns undefined for non-incompat ids (no fallback needed)", () => {
    expect(chatGptFallbackFor("gpt-5.5")).toBeUndefined();
    expect(chatGptFallbackFor("brand-new-future-model")).toBeUndefined();
  });

  it("returns gpt-5.5 for curated apiKeyOnly ids", () => {
    expect(chatGptFallbackFor("gpt-5-codex")).toBe("gpt-5.5");
  });

  it("returns gpt-5.5 for runtime-learned incompat ids", async () => {
    await markOAuthIncompat("gpt-5.4-mini");
    expect(chatGptFallbackFor("gpt-5.4-mini")).toBe("gpt-5.5");

    await markOAuthIncompat("gpt-5.4");
    expect(chatGptFallbackFor("gpt-5.4")).toBe("gpt-5.5");
  });

  it("returns undefined for gpt-5.5 itself even if marked (no further fallback)", async () => {
    // Pathological case — if even gpt-5.5 fails, the credential is the
    // problem and there's no model we can swap to. The handler should
    // surface this as an error rather than loop.
    await markOAuthIncompat("gpt-5.5");
    expect(chatGptFallbackFor("gpt-5.5")).toBeUndefined();
  });
});

// ── isSilentOAuthExitError — the Pandario 23:13Z regression ──────────────

describe("isSilentOAuthExitError", () => {
  it("detects the canonical silent exit-1 wrapper from codex-sdk", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 1: Reading prompt from stdin...\n",
      ),
    ).toBe(true);
  });

  it("matches when the SDK uses exit code 2 (observed variation)", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 2: Reading prompt from stdin...",
      ),
    ).toBe(true);
  });

  it("is whitespace-tolerant and case-insensitive", () => {
    expect(
      isSilentOAuthExitError(
        "codex   exec  exited  with  code  1: reading PROMPT from stdin...",
      ),
    ).toBe(true);
  });

  it("does NOT match when the explicit mismatch text is present (other detector handles it)", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 1: not supported when using Codex with a ChatGPT account",
      ),
    ).toBe(false);
  });

  it("does NOT match generic exit-1 errors (false positive guard)", () => {
    expect(
      isSilentOAuthExitError(
        "Codex Exec exited with code 1: connection refused",
      ),
    ).toBe(false);
    expect(
      isSilentOAuthExitError("Codex Exec exited with code 1: ENOENT"),
    ).toBe(false);
  });

  it("does NOT match an empty or undefined message", () => {
    expect(isSilentOAuthExitError("")).toBe(false);
    expect(isSilentOAuthExitError(undefined as unknown as string)).toBe(false);
  });

  it("does NOT match unrelated text containing one keyword", () => {
    expect(isSilentOAuthExitError("Reading prompt from stdin")).toBe(false);
    expect(isSilentOAuthExitError("Codex Exec exited with code 0")).toBe(false);
  });

  it("isChatGptModelMismatchError still matches the explicit form", () => {
    expect(
      isChatGptModelMismatchError(
        "400 Bad Request: not supported when using Codex with a ChatGPT account",
      ),
    ).toBe(true);
  });
});
