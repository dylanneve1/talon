import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("../storage/history.js", () => ({
  getRecentFormatted: vi.fn(() => ""),
  searchHistory: vi.fn(() => ""),
  getMessagesByUser: vi.fn(() => ""),
  getKnownUsers: vi.fn(() => ""),
}));

vi.mock("../storage/media-index.js", () => ({
  formatMediaIndex: vi.fn(() => ""),
}));

vi.mock("../storage/cron-store.js", () => ({
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  getCronJobsForChat: vi.fn(() => []),
  updateCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  validateCronExpression: vi.fn(() => ({ valid: true })),
  generateCronId: vi.fn(() => "test-id"),
  loadCronJobs: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

const { classify, TalonError } = await import("../core/errors.js");
await import("../storage/cron-store.js");
const { handleSharedAction } = await import("../core/gateway-actions.js");
const { resolveModelName } = await import("../storage/chat-settings.js");
const { registerClaudeModelsStatic, CLAUDE_MODELS_STATIC } =
  await import("../backend/claude-sdk/models.js");
registerClaudeModelsStatic(CLAUDE_MODELS_STATIC);
const { Cron } = await import("croner");

// ── Configuration ───────────────────────────────────────────────────────────

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;
const fcParams = { numRuns: NUM_RUNS };

// ── Fuzz tests ───────────────────────────────────────────────────────────────

describe("fuzz: classify()", () => {
  it("never throws on random string inputs", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = classify(input);
        expect(result).toBeInstanceOf(TalonError);
        expect(typeof result.reason).toBe("string");
        expect(typeof result.retryable).toBe("boolean");
        expect(typeof result.message).toBe("string");
      }),
      fcParams,
    );
  });

  it("never throws on random Error inputs", () => {
    fc.assert(
      fc.property(fc.string(), (msg) => {
        const result = classify(new Error(msg));
        expect(result).toBeInstanceOf(TalonError);
        expect(result.reason).toBeTruthy();
      }),
      fcParams,
    );
  });

  it("never throws on random non-string/non-Error inputs", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.constant(undefined),
          fc.double(),
          fc.object(),
        ),
        (input) => {
          const result = classify(input);
          expect(result).toBeInstanceOf(TalonError);
          expect(result.reason).toBeTruthy();
        },
      ),
      fcParams,
    );
  });

  it("always returns a valid ErrorReason", () => {
    const validReasons = new Set([
      "rate_limit",
      "overloaded",
      "network",
      "auth",
      "context_length",
      "session_expired",
      "bad_request",
      "forbidden",
      "telegram_api",
      "unknown",
    ]);

    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = classify(input);
        expect(validReasons.has(result.reason)).toBe(true);
      }),
      fcParams,
    );
  });

  it("retryAfterMs is never negative when present", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = classify(input);
        if (result.retryAfterMs !== undefined) {
          expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
        }
      }),
      fcParams,
    );
  });
});

// Real cron validator (the import is mocked, so we use Cron directly)
function realValidateCron(
  expr: string,
  timezone?: string,
): { valid: boolean; error?: string } {
  try {
    const cron = new Cron(expr, { timezone: timezone ?? undefined });
    cron.nextRun();
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("fuzz: validateCronExpression()", () => {
  it("never throws on random strings, always returns { valid: boolean }", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = realValidateCron(input);
        expect(typeof result.valid).toBe("boolean");
        if (!result.valid) {
          expect(typeof result.error).toBe("string");
        }
      }),
      fcParams,
    );
  });

  it("never throws on random strings with random timezone strings", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (expr, tz) => {
        const result = realValidateCron(expr, tz);
        expect(typeof result.valid).toBe("boolean");
      }),
      fcParams,
    );
  });
});

describe("fuzz: handleSharedAction() — unknown actions", () => {
  it("returns null for random action names (never crashes)", () => {
    fc.assert(
      fc.asyncProperty(fc.string(), async (actionName) => {
        // Skip known action names to test only the default/unknown path
        const knownActions = new Set([
          "read_history",
          "search_history",
          "get_user_messages",
          "list_known_users",
          "list_media",
          "fetch_url",
          "create_cron_job",
          "list_cron_jobs",
          "edit_cron_job",
          "delete_cron_job",
        ]);
        if (knownActions.has(actionName)) return;

        const result = await handleSharedAction({ action: actionName }, 123);
        expect(result).toBeNull();
      }),
      fcParams,
    );
  });

  it("never crashes with random body objects", () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({
          action: fc.string(),
          extra: fc.string(),
          num: fc.integer(),
        }),
        async (body) => {
          const knownActions = new Set([
            "read_history",
            "search_history",
            "get_user_messages",
            "list_known_users",
            "list_media",
            "fetch_url",
            "create_cron_job",
            "list_cron_jobs",
            "edit_cron_job",
            "delete_cron_job",
          ]);
          if (knownActions.has(body.action)) return;

          const result = await handleSharedAction(body, 123);
          expect(result).toBeNull();
        },
      ),
      fcParams,
    );
  });
});

describe("fuzz: fetch_url URL validation", () => {
  let originalFetch: typeof globalThis.fetch;

  it("random strings as URLs return ok:false or null, never throw", () => {
    originalFetch = globalThis.fetch;
    // Mock fetch to prevent real network calls
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("mocked")));

    fc.assert(
      fc.asyncProperty(fc.string(), async (url) => {
        const result = await handleSharedAction(
          { action: "fetch_url", url },
          123,
        );
        // Should either return an error result or handle gracefully
        expect(result).not.toBeUndefined();
        if (result !== null) {
          expect(typeof result.ok).toBe("boolean");
          if (!result.ok) {
            expect(typeof result.error).toBe("string");
          }
        }
      }),
      fcParams,
    );

    globalThis.fetch = originalFetch;
  });

  it("rejects all non-http/https protocols", () => {
    fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "ftp",
          "file",
          "javascript",
          "data",
          "ws",
          "wss",
          "ssh",
        ),
        fc.webUrl(),
        async (protocol, path) => {
          const url = `${protocol}://${path.replace(/^https?:\/\//, "")}`;
          const result = await handleSharedAction(
            { action: "fetch_url", url },
            123,
          );
          if (result !== null) {
            // Should not be ok for non-http protocols
            // (some invalid URLs will get "Invalid URL" error at parse time)
            expect(result.ok).toBe(false);
          }
        },
      ),
      fcParams,
    );
  });
});

describe("fuzz: resolveModelName()", () => {
  it("never throws on random strings, always returns a string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = resolveModelName(input);
        expect(typeof result).toBe("string");
      }),
      fcParams,
    );
  });

  it("always returns trimmed output", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = resolveModelName(input);
        expect(result).toBe(result.trim());
      }),
      fcParams,
    );
  });

  it("known aliases resolve to the expected SDK model IDs", () => {
    const aliasMappings = [
      ["sonnet", "default"],
      ["opus", "opus"],
      ["haiku", "haiku"],
      ["sonnet-4.6", "default"],
      ["opus-4.6", "opus"],
      ["haiku-4.5", "haiku"],
      ["sonnet-4-6", "default"],
      ["opus-4-6", "opus"],
      ["haiku-4-5", "haiku"],
    ] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...aliasMappings),
        fc.constantFrom("", " ", "  "),
        ([alias, expectedModelId], padding) => {
          const result = resolveModelName(padding + alias + padding);
          expect(result).toBe(expectedModelId);
        },
      ),
      fcParams,
    );
  });

  it("unknown strings pass through trimmed", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const trimmed = input.trim().toLowerCase();
        const knownAliases = [
          "sonnet",
          "opus",
          "haiku",
          "sonnet-4.6",
          "opus-4.6",
          "haiku-4.5",
          "sonnet-4-6",
          "opus-4-6",
          "haiku-4-5",
        ];
        if (knownAliases.includes(trimmed)) return;

        const result = resolveModelName(input);
        expect(result).toBe(input.trim());
      }),
      fcParams,
    );
  });
});
