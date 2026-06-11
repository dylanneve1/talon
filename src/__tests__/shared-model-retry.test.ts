/**
 * Tests for `classifyRetry` — the shared decision logic for what to do
 * after a backend error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRetry } from "../backend/shared/model-retry.js";
import { TalonError } from "../core/errors.js";

// Mock getFallbackModel — we don't want to depend on the actual model
// registry here; this lets us test all branches.
vi.mock("../core/models/catalog.js", () => ({
  getFallbackModel: vi.fn(),
}));

const { getFallbackModel } = await import("../core/models/catalog.js");
const getFallbackModelMock = vi.mocked(getFallbackModel);

describe("classifyRetry", () => {
  beforeEach(() => {
    getFallbackModelMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("propagates when already retried", () => {
    const err = new TalonError("expired", { reason: "session_expired" });
    const res = classifyRetry({ error: err, activeModel: "x", retried: true });
    expect(res.kind).toBe("propagate");
  });

  it("session_expired → reset_and_retry", () => {
    const err = new TalonError("expired", { reason: "session_expired" });
    const res = classifyRetry({ error: err, activeModel: "x", retried: false });
    expect(res.kind).toBe("reset_and_retry");
    if (res.kind === "reset_and_retry") {
      expect(res.reason).toBe("session_expired");
    }
  });

  it("context_length → reset_and_retry", () => {
    const err = new TalonError("overflow", { reason: "context_length" });
    const res = classifyRetry({ error: err, activeModel: "x", retried: false });
    expect(res.kind).toBe("reset_and_retry");
    if (res.kind === "reset_and_retry") {
      expect(res.reason).toBe("context_length");
    }
  });

  it("retryable error with fallback → fallback_model", () => {
    const err = new TalonError("rate", {
      reason: "rate_limit",
      retryable: true,
    });
    getFallbackModelMock.mockReturnValue("sonnet-4-6");

    const res = classifyRetry({
      error: err,
      activeModel: "opus-4-7",
      retried: false,
    });
    expect(res.kind).toBe("fallback_model");
    if (res.kind === "fallback_model") {
      expect(res.fallbackModelId).toBe("sonnet-4-6");
    }
    expect(getFallbackModelMock).toHaveBeenCalledWith("opus-4-7");
  });

  it("retryable error with no fallback → propagate", () => {
    const err = new TalonError("rate", {
      reason: "rate_limit",
      retryable: true,
    });
    getFallbackModelMock.mockReturnValue(null);

    const res = classifyRetry({
      error: err,
      activeModel: "opus-4-7",
      retried: false,
    });
    expect(res.kind).toBe("propagate");
  });

  it("non-retryable non-recoverable error → propagate", () => {
    const err = new TalonError("auth", { reason: "auth", retryable: false });
    const res = classifyRetry({
      error: err,
      activeModel: "opus-4-7",
      retried: false,
    });
    expect(res.kind).toBe("propagate");
  });

  it("retryable overloaded → fallback_model when available", () => {
    const err = new TalonError("overload", {
      reason: "overloaded",
      retryable: true,
    });
    getFallbackModelMock.mockReturnValue("haiku");
    const res = classifyRetry({
      error: err,
      activeModel: "opus-4-7",
      retried: false,
    });
    expect(res.kind).toBe("fallback_model");
  });
});
