/**
 * Extended edge-case tests for src/core/errors.ts
 *
 * Complements the baseline coverage in errors.test.ts with additional
 * edge cases: more network codes, non-Error inputs, nested causes,
 * all friendlyMessage paths, gateway status codes, and TalonError
 * cause-chain preservation.
 */

import { describe, it, expect } from "vitest";
import { TalonError, classify, friendlyMessage } from "../core/errors.js";

// ── classify — additional network codes ────────────────────────────────────

describe("classify — additional network codes", () => {
  it("classifies ECONNRESET as network/retryable", () => {
    const err = classify(new Error("ECONNRESET"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("classifies ECONNABORTED as network/retryable", () => {
    const err = classify(new Error("ECONNABORTED"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("classifies 'connection reset' string as network/retryable", () => {
    const err = classify(new Error("connection reset by peer"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("classifies 'fetch failed' as network/retryable", () => {
    const err = classify(new Error("fetch failed: SSL handshake timeout"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });

  it("classifies ETIMEDOUT as network/retryable", () => {
    const err = classify(new Error("connect ETIMEDOUT 1.2.3.4:443"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });
});

// ── classify — non-Error inputs ───────────────────────────────────────────

describe("classify — non-Error inputs", () => {
  it("handles plain object input (converts to string)", () => {
    const err = classify({ message: "rate limit" });
    expect(err.reason).toBe("rate_limit");
    expect(err.retryable).toBe(true);
  });

  it("handles numeric input", () => {
    const err = classify(42);
    expect(err.reason).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("handles null input", () => {
    const err = classify(null);
    expect(err.reason).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("handles undefined input", () => {
    const err = classify(undefined);
    expect(err.reason).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("handles boolean true", () => {
    const err = classify(true);
    expect(err.reason).toBe("unknown");
  });

  it("handles string that matches 'rate limit'", () => {
    const err = classify("rate limit exceeded");
    expect(err.reason).toBe("rate_limit");
    expect(err.retryable).toBe(true);
  });

  it("handles string that matches 'overloaded'", () => {
    const err = classify("server overloaded please retry");
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });
});

// ── classify — nested cause errors ───────────────────────────────────────

describe("classify — nested cause errors", () => {
  it("classifies based on the top-level error message, not the cause message", () => {
    const cause = new Error("rate limit exceeded");
    const wrapper = new Error("Something failed", { cause });
    // The wrapper message "Something failed" does not match any known pattern
    const err = classify(wrapper);
    expect(err.reason).toBe("unknown");
  });

  it("preserves the original Error as the cause property", () => {
    const original = new Error("503 Service Unavailable");
    const classified = classify(original);
    expect(classified.cause).toBe(original);
  });

  it("cause is undefined for non-Error inputs (string, number, etc.)", () => {
    const err = classify("overloaded");
    // cause is only set when err instanceof Error
    expect(err.cause).toBeUndefined();
  });

  it("cause is undefined for null/undefined inputs", () => {
    expect(classify(null).cause).toBeUndefined();
    expect(classify(undefined).cause).toBeUndefined();
  });

  it("TalonError passed through classify preserves its existing cause", () => {
    const inner = new Error("original cause");
    const talon = new TalonError("wrapped", {
      reason: "network",
      retryable: true,
      cause: inner,
    });
    const result = classify(talon);
    expect(result).toBe(talon); // exact same reference
    expect(result.cause).toBe(inner);
  });
});

// ── classify — HTTP gateway status codes ────────────────────────────────

describe("classify — gateway status codes", () => {
  it("classifies 502 Bad Gateway as overloaded/retryable", () => {
    const err = classify(new Error("502 Bad Gateway"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(502);
  });

  it("classifies 504 Gateway Timeout as overloaded/retryable", () => {
    const err = classify(new Error("504 Gateway Timeout"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(504);
  });

  it("classifies 408 Request Timeout as network/retryable", () => {
    const err = classify(new Error("408 Request Timeout"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(408);
  });

  it("classifies 500 Internal Server Error as overloaded/retryable", () => {
    const err = classify(new Error("500 Internal Server Error"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(500);
    expect(err.retryAfterMs).toBe(2000);
  });

  it("classifies 503 Service Unavailable as overloaded/retryable", () => {
    // The "503" token in the message triggers the overloaded regex directly
    const err = classify(new Error("503 Service Unavailable"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  it("classifies 401 Unauthorized as auth/non-retryable", () => {
    const err = classify(new Error("401 Unauthorized"));
    expect(err.reason).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(401);
  });

  it("classifies 403 Forbidden as forbidden/non-retryable", () => {
    const err = classify(new Error("403 Forbidden"));
    expect(err.reason).toBe("forbidden");
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(403);
  });
});

// ── friendlyMessage — all error reasons ────────────────────────────────

describe("friendlyMessage — all error reasons", () => {
  it("rate_limit without retryAfterMs falls back to default template", () => {
    // When retryAfterMs is provided by classify it defaults to 60000
    const err = classify(new Error("rate limit exceeded"));
    const msg = friendlyMessage(err);
    // Should contain "60 seconds" since default retryAfterMs is 60_000
    expect(msg).toContain("60 seconds");
  });

  it("rate_limit with custom retryAfterMs shows correct seconds", () => {
    const err = new TalonError("rate limited", {
      reason: "rate_limit",
      retryable: true,
      retryAfterMs: 45_000,
    });
    const msg = friendlyMessage(err);
    expect(msg).toContain("45 seconds");
  });

  it("rate_limit with retryAfterMs of 30000 shows 30 seconds", () => {
    const err = classify(new Error("rate limit, retry after 30 seconds"));
    expect(friendlyMessage(err)).toContain("30 seconds");
  });

  it("overloaded reason contains 'busy'", () => {
    const err = new TalonError("overloaded", {
      reason: "overloaded",
      retryable: true,
    });
    expect(friendlyMessage(err)).toContain("busy");
  });

  it("network reason contains 'Connection'", () => {
    const err = new TalonError("network error", {
      reason: "network",
      retryable: true,
    });
    expect(friendlyMessage(err)).toContain("Connection");
  });

  it("auth reason contains 'API key'", () => {
    const err = new TalonError("auth error", {
      reason: "auth",
      retryable: false,
    });
    expect(friendlyMessage(err)).toContain("API key");
  });

  it("context_length reason contains '/reset'", () => {
    const err = new TalonError("too long", {
      reason: "context_length",
      retryable: false,
    });
    expect(friendlyMessage(err)).toContain("/reset");
  });

  it("session_expired reason returns the TalonError message verbatim", () => {
    const customMsg = "Your session timed out. Please send a new message.";
    const err = new TalonError(customMsg, {
      reason: "session_expired",
      retryable: false,
    });
    expect(friendlyMessage(err)).toBe(customMsg);
  });

  it("bad_request reason contains 'went wrong'", () => {
    const err = new TalonError("bad request", {
      reason: "bad_request",
      retryable: false,
    });
    expect(friendlyMessage(err)).toContain("went wrong");
  });

  it("forbidden reason contains 'Permission denied'", () => {
    const err = new TalonError("forbidden", {
      reason: "forbidden",
      retryable: false,
    });
    expect(friendlyMessage(err)).toContain("Permission denied");
  });

  it("telegram_api reason contains 'Telegram'", () => {
    const err = new TalonError("telegram api failure", {
      reason: "telegram_api",
      retryable: false,
    });
    expect(friendlyMessage(err)).toContain("Telegram");
  });

  it("unknown reason contains 'Something went wrong'", () => {
    const err = new TalonError("mystery error", {
      reason: "unknown",
      retryable: false,
    });
    expect(friendlyMessage(err)).toContain("Something went wrong");
  });

  it("classifies raw Error before generating message", () => {
    // Passing a raw Error (not TalonError) should trigger auto-classification
    const rawErr = new Error("ECONNREFUSED connection refused");
    const msg = friendlyMessage(rawErr);
    expect(msg).toContain("Connection");
  });

  it("handles string input by classifying it first", () => {
    const msg = friendlyMessage("503 overloaded service");
    expect(msg).toContain("busy");
  });

  it("handles null input without throwing", () => {
    expect(() => friendlyMessage(null)).not.toThrow();
  });
});

// ── TalonError — construction and properties ────────────────────────────

describe("TalonError — construction and properties", () => {
  it("is instanceof Error and instanceof TalonError", () => {
    const err = new TalonError("test", { reason: "network", retryable: true });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TalonError);
  });

  it("name property is 'TalonError'", () => {
    expect(new TalonError("x", { reason: "unknown" }).name).toBe("TalonError");
  });

  it("reason is stored correctly for every known reason", () => {
    const reasons = [
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
    ] as const;
    for (const reason of reasons) {
      const err = new TalonError("msg", { reason });
      expect(err.reason).toBe(reason);
    }
  });

  it("retryable defaults to false when not provided", () => {
    const err = new TalonError("x", { reason: "unknown" });
    expect(err.retryable).toBe(false);
  });

  it("retryable is true when explicitly set", () => {
    const err = new TalonError("x", { reason: "network", retryable: true });
    expect(err.retryable).toBe(true);
  });

  it("status is preserved", () => {
    const err = new TalonError("x", { reason: "auth", status: 401 });
    expect(err.status).toBe(401);
  });

  it("status is undefined when not provided", () => {
    const err = new TalonError("x", { reason: "unknown" });
    expect(err.status).toBeUndefined();
  });

  it("retryAfterMs is preserved", () => {
    const err = new TalonError("x", {
      reason: "rate_limit",
      retryAfterMs: 30_000,
    });
    expect(err.retryAfterMs).toBe(30_000);
  });

  it("retryAfterMs is undefined when not provided", () => {
    const err = new TalonError("x", { reason: "network" });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("preserves a cause Error", () => {
    const cause = new Error("root cause");
    const err = new TalonError("wrapped", { reason: "unknown", cause });
    expect(err.cause).toBe(cause);
  });

  it("preserves a cause TalonError (nested chain)", () => {
    const inner = new TalonError("inner", {
      reason: "network",
      retryable: true,
    });
    const outer = new TalonError("outer", {
      reason: "overloaded",
      retryable: true,
      cause: inner,
    });
    expect(outer.cause).toBe(inner);
    expect((outer.cause as TalonError).reason).toBe("network");
  });

  it("cause is undefined when not provided", () => {
    const err = new TalonError("x", { reason: "unknown" });
    expect(err.cause).toBeUndefined();
  });

  it("message is stored correctly", () => {
    const err = new TalonError("very specific message", { reason: "auth" });
    expect(err.message).toBe("very specific message");
  });

  it("stack trace is present", () => {
    const err = new TalonError("x", { reason: "unknown" });
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("TalonError");
  });
});

// ── Line 128: auth status fallback ──────────────────────────────────────────

describe("classify — auth without HTTP status in message", () => {
  it("uses 401 as default status when 'authentication' in message has no numeric status", () => {
    const err = classify(new Error("authentication failed"));
    expect(err.reason).toBe("auth");
    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
  });

  it("auth pattern takes priority over status code for 'unauthorized' message", () => {
    // 'unauthorized' matches auth regex before 403 status check is reached
    const err = classify(new Error("unauthorized: 403 Forbidden"));
    expect(err.reason).toBe("auth");
    expect(err.status).toBe(403); // extracted numeric status overrides default 401
    expect(err.retryable).toBe(false);
  });
});
