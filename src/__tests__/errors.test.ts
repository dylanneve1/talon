import { describe, it, expect } from "vitest";
import { TalonError, classify, friendlyMessage } from "../core/errors.js";

describe("classify", () => {
  it("classifies rate limit errors", () => {
    const err = classify(new Error("429 Too Many Requests"));
    expect(err.reason).toBe("rate_limit");
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(429);
  });

  it("extracts retry-after from rate limit", () => {
    const err = classify(new Error("rate limit, retry after 30 seconds"));
    expect(err.reason).toBe("rate_limit");
    expect(err.retryAfterMs).toBe(30000);
  });

  it("classifies overloaded errors", () => {
    const err = classify(new Error("503 Service Unavailable"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  it("classifies generic 5xx as overloaded", () => {
    const err = classify(new Error("502 Bad Gateway"));
    expect(err.reason).toBe("overloaded");
    expect(err.retryable).toBe(true);
  });

  it("classifies network errors", () => {
    expect(classify(new Error("ECONNREFUSED")).reason).toBe("network");
    expect(classify(new Error("fetch failed")).reason).toBe("network");
    expect(classify(new Error("ETIMEDOUT")).reason).toBe("network");
    expect(classify(new Error("ENOTFOUND")).reason).toBe("network");
  });

  it("classifies session expired errors", () => {
    const err = classify(new Error("session expired"));
    expect(err.reason).toBe("session_expired");
    expect(err.retryable).toBe(false);
  });

  it("classifies context length errors", () => {
    const err = classify(new Error("context length exceeded"));
    expect(err.reason).toBe("context_length");
    expect(err.retryable).toBe(false);
  });

  it("classifies auth errors", () => {
    const err = classify(new Error("401 Unauthorized"));
    expect(err.reason).toBe("auth");
    expect(err.retryable).toBe(false);
  });

  it("classifies 400 as bad_request", () => {
    const err = classify(new Error("400 Bad Request"));
    expect(err.reason).toBe("bad_request");
    expect(err.retryable).toBe(false);
  });

  it("classifies 403 as forbidden", () => {
    const err = classify(new Error("403 Forbidden"));
    expect(err.reason).toBe("forbidden");
    expect(err.retryable).toBe(false);
  });

  it("returns unknown for unrecognized errors", () => {
    const err = classify(new Error("something weird"));
    expect(err.reason).toBe("unknown");
    expect(err.retryable).toBe(false);
  });

  it("passes through TalonError unchanged", () => {
    const original = new TalonError("test", { reason: "rate_limit", retryable: true });
    expect(classify(original)).toBe(original);
  });

  it("handles string errors", () => {
    const err = classify("rate limit hit");
    expect(err.reason).toBe("rate_limit");
  });

  it("handles non-Error objects", () => {
    const err = classify(42);
    expect(err.reason).toBe("unknown");
  });

  it("preserves original error as cause", () => {
    const original = new Error("503 overloaded");
    const err = classify(original);
    expect(err.cause).toBe(original);
  });

  it("classifies 500 as retryable server error", () => {
    const err = classify(new Error("500 Internal Server Error"));
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(500);
  });

  it("classifies 504 as retryable", () => {
    const err = classify(new Error("504 Gateway Timeout"));
    expect(err.retryable).toBe(true);
  });

  it("classifies ENOTFOUND as network error", () => {
    const err = classify(new Error("ENOTFOUND"));
    expect(err.reason).toBe("network");
    expect(err.retryable).toBe(true);
  });
});

describe("friendlyMessage", () => {
  it("returns rate limit message with retry time", () => {
    const err = new TalonError("x", { reason: "rate_limit", retryAfterMs: 30000 });
    expect(friendlyMessage(err)).toContain("30 seconds");
  });

  it("returns overloaded message", () => {
    expect(friendlyMessage(new Error("503"))).toContain("busy");
  });

  it("returns network error message", () => {
    expect(friendlyMessage(new Error("ECONNREFUSED"))).toContain("Connection");
  });

  it("returns context length message with /reset", () => {
    const msg = friendlyMessage(new Error("context length exceeded"));
    expect(msg).toContain("/reset");
  });

  it("passes through session expired messages as-is", () => {
    const msg = "Session expired. Send your message again.";
    const err = new TalonError(msg, { reason: "session_expired" });
    expect(friendlyMessage(err)).toBe(msg);
  });

  it("classifies raw errors before generating message", () => {
    expect(friendlyMessage(new Error("some random failure"))).toContain("Something went wrong");
  });
});

describe("TalonError", () => {
  it("is an instanceof Error", () => {
    const err = new TalonError("test", { reason: "unknown" });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TalonError);
  });

  it("has correct name", () => {
    const err = new TalonError("test", { reason: "rate_limit" });
    expect(err.name).toBe("TalonError");
  });

  it("defaults retryable to false", () => {
    const err = new TalonError("test", { reason: "unknown" });
    expect(err.retryable).toBe(false);
  });

  it("preserves cause", () => {
    const cause = new Error("original");
    const err = new TalonError("wrapped", { reason: "unknown", cause });
    expect(err.cause).toBe(cause);
  });
});
