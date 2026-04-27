/**
 * Tests for withRetry() exported from src/core/gateway.ts
 *
 * withRetry wraps p-retry.  We mock p-retry so that:
 *   - The mock immediately drives the retry loop deterministically (no real
 *     delays), and
 *   - We can observe exactly how many times the inner function was called.
 *
 * The contract under test:
 *   1. Success on first attempt — fn called once, result returned.
 *   2. Retryable errors (network, overloaded, rate_limit) — fn retried up to
 *      3 total attempts; result returned on the first successful call.
 *   3. Non-retryable errors (auth, bad_request, context_length, forbidden,
 *      unknown) — fn called once and the error is re-thrown immediately.
 *   4. All retries exhausted — the final error is thrown after 3 attempts.
 *   5. TalonError.retryAfterMs is plumbed through classify.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (before any dynamic import) ─────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

vi.mock("../util/watchdog.js", () => ({
  recordError: vi.fn(),
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

vi.mock("../core/gateway-actions.js", () => ({
  handleSharedAction: vi.fn(async () => null),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

// ── Real p-retry (we want to exercise the actual retry logic with fast
//    timeouts — no mocking needed since we use very short delays).
//    We DO NOT mock p-retry; instead tests that would be slow use
//    non-retryable errors so they return immediately, and retryable-path
//    tests are designed to succeed on a subsequent attempt.

// ── Dynamic import ─────────────────────────────────────────────────────────

const { withRetry } = await import("../core/gateway.js");
import { TalonError, classify } from "../core/errors.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a TalonError for the given reason. */
function talonErr(
  reason:
    | "network"
    | "overloaded"
    | "rate_limit"
    | "auth"
    | "bad_request"
    | "context_length"
    | "unknown",
  retryAfterMs?: number,
): TalonError {
  const retryable = ["network", "overloaded", "rate_limit"].includes(reason);
  return new TalonError(`${reason} error`, {
    reason,
    retryable,
    retryAfterMs,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  describe("success on first attempt", () => {
    it("returns the value without retrying", async () => {
      const fn = vi.fn(async () => "ok");
      const result = await withRetry(fn);
      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns non-string values correctly", async () => {
      const obj = { data: 42, nested: { flag: true } };
      const result = await withRetry(async () => obj);
      expect(result).toBe(obj);
    });

    it("returns undefined correctly", async () => {
      const result = await withRetry(async () => undefined);
      expect(result).toBeUndefined();
    });
  });

  describe("non-retryable errors — abort immediately", () => {
    it("throws on auth error without retrying", async () => {
      const fn = vi.fn(async () => {
        throw talonErr("auth");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      // Function should only be called once — no retries for non-retryable errors
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws on bad_request error without retrying", async () => {
      const fn = vi.fn(async () => {
        throw talonErr("bad_request");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws on context_length error without retrying", async () => {
      const fn = vi.fn(async () => {
        throw talonErr("context_length");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws on forbidden error without retrying", async () => {
      const fn = vi.fn(async () => {
        throw new TalonError("403 Forbidden", {
          reason: "forbidden",
          retryable: false,
          status: 403,
        });
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("throws on unknown error without retrying", async () => {
      const fn = vi.fn(async () => {
        throw talonErr("unknown");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("re-classifies raw (non-TalonError) non-retryable errors and aborts", async () => {
      // classify("401 Unauthorized") → auth → non-retryable
      const fn = vi.fn(async () => {
        throw new Error("401 Unauthorized");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("re-classifies 400 Bad Request as non-retryable", async () => {
      const fn = vi.fn(async () => {
        throw new Error("400 Bad Request");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("retryable errors — retries and eventually succeeds", () => {
    it("succeeds on second attempt after a network error", async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          throw talonErr("network");
        }
        return "success";
      });

      const result = await withRetry(fn);
      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("succeeds on third attempt after two overloaded errors", async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls < 3) {
          throw talonErr("overloaded");
        }
        return "eventually ok";
      });

      const result = await withRetry(fn);
      expect(result).toBe("eventually ok");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("succeeds on second attempt after a rate_limit error", async () => {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          // Small retryAfterMs so the test runs fast
          throw talonErr("rate_limit", 1);
        }
        return "rate limit passed";
      });

      const result = await withRetry(fn);
      expect(result).toBe("rate limit passed");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("exhausting all retries", () => {
    it("throws the last error after 3 total attempts for retryable errors", async () => {
      const networkErr = talonErr("network");
      const fn = vi.fn(async () => {
        throw networkErr;
      });

      await expect(withRetry(fn)).rejects.toThrow();
      // withRetry is configured with retries: 2 (3 total attempts)
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws the last error after 3 total attempts for overloaded errors", async () => {
      const fn = vi.fn(async () => {
        throw talonErr("overloaded");
      });

      await expect(withRetry(fn)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("TalonError retryAfterMs is respected by classify", () => {
    it("classify preserves retryAfterMs from rate-limit message", () => {
      // Verify that classify() correctly parses the retryAfterMs so
      // withRetry has accurate delay information.
      const err = classify(new Error("rate limit hit, retry after 45 seconds"));
      expect(err.reason).toBe("rate_limit");
      expect(err.retryAfterMs).toBe(45_000);
    });

    it("classify defaults retryAfterMs to 60000 when no retry hint is given", () => {
      const err = classify(new Error("rate limit exceeded"));
      expect(err.retryAfterMs).toBe(60_000);
    });

    it("classify caps retryAfterMs at 300000", () => {
      const err = classify(new Error("rate limit, retry after 9999 seconds"));
      expect(err.retryAfterMs).toBe(300_000);
    });

    it("network errors have retryAfterMs of 2000", () => {
      const err = classify(new Error("ECONNREFUSED"));
      expect(err.retryAfterMs).toBe(2_000);
    });

    it("overloaded errors have retryAfterMs of 5000 when matched via keyword", () => {
      const err = classify(new Error("server is overloaded"));
      expect(err.retryAfterMs).toBe(5_000);
    });

    it("5xx server errors have retryAfterMs of 2000", () => {
      const err = classify(new Error("500 Internal Server Error"));
      expect(err.retryAfterMs).toBe(2_000);
    });
  });

  describe("error identity through withRetry", () => {
    it("non-retryable TalonError reason is preserved in thrown error", async () => {
      const original = talonErr("auth");
      await expect(
        withRetry(async () => {
          throw original;
        }),
      ).rejects.toMatchObject({ reason: "auth" });
    });

    it("after exhausted retries the thrown error is a TalonError", async () => {
      await expect(
        withRetry(async () => {
          throw talonErr("network");
        }),
      ).rejects.toBeInstanceOf(TalonError);
    });

    it("non-Error throws are classified and the TalonError is thrown for non-retryable", async () => {
      await expect(
        withRetry(async () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 42; // will be classified as "unknown" (non-retryable)
        }),
      ).rejects.toBeInstanceOf(TalonError);
    });
  });

  describe("concurrency — multiple independent withRetry calls", () => {
    it("two simultaneous calls both succeed independently", async () => {
      const [r1, r2] = await Promise.all([
        withRetry(async () => "first"),
        withRetry(async () => "second"),
      ]);
      expect(r1).toBe("first");
      expect(r2).toBe("second");
    });

    it("one failing call does not affect a parallel successful call", async () => {
      const results = await Promise.allSettled([
        withRetry(async () => {
          throw talonErr("auth"); // aborts immediately, non-retryable
        }),
        withRetry(async () => "safe"),
      ]);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");
      if (results[1].status === "fulfilled") {
        expect(results[1].value).toBe("safe");
      }
    });
  });
});
