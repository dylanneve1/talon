/**
 * Tests for `classifyRetry` — the shared decision logic for what to do
 * after a backend error.
 */

import { describe, expect, it } from "vitest";
import { classifyRetry } from "../backend/shared/model-retry.js";
import { TalonError } from "../core/errors.js";

describe("classifyRetry", () => {
  it("propagates when already retried", () => {
    const err = new TalonError("expired", { reason: "session_expired" });
    const res = classifyRetry({ error: err, activeModel: "x", retried: true });
    expect(res.kind).toBe("propagate");
  });

  it("session_expired -> reset_and_retry", () => {
    const err = new TalonError("expired", { reason: "session_expired" });
    const res = classifyRetry({ error: err, activeModel: "x", retried: false });
    expect(res.kind).toBe("reset_and_retry");
    if (res.kind === "reset_and_retry") {
      expect(res.reason).toBe("session_expired");
    }
  });

  it("context_length -> reset_and_retry", () => {
    const err = new TalonError("overflow", { reason: "context_length" });
    const res = classifyRetry({ error: err, activeModel: "x", retried: false });
    expect(res.kind).toBe("reset_and_retry");
    if (res.kind === "reset_and_retry") {
      expect(res.reason).toBe("context_length");
    }
  });

  it("retryable errors propagate instead of switching models", () => {
    const err = new TalonError("rate", {
      reason: "rate_limit",
      retryable: true,
    });

    const res = classifyRetry({
      error: err,
      activeModel: "opus-4-7",
      retried: false,
    });
    expect(res.kind).toBe("propagate");
  });

  it("non-retryable non-recoverable error -> propagate", () => {
    const err = new TalonError("auth", { reason: "auth", retryable: false });
    const res = classifyRetry({
      error: err,
      activeModel: "opus-4-7",
      retried: false,
    });
    expect(res.kind).toBe("propagate");
  });
});
