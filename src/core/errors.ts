/**
 * Typed error classification.
 *
 * One place to classify errors. Every module reads `err.reason` instead
 * of regex-matching error messages. Inspired by OpenClaw's FailoverError.
 */

// ── Error reasons ───────────────────────────────────────────────────────────

type ErrorReason =
  | "rate_limit"
  | "overloaded"
  | "network"
  | "auth"
  | "context_length"
  | "session_expired"
  | "bad_request"
  | "forbidden"
  | "telegram_api"
  | "unknown";

// ── TalonError class ────────────────────────────────────────────────────────

export class TalonError extends Error {
  readonly reason: ErrorReason;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    params: {
      reason: ErrorReason;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "TalonError";
    this.reason = params.reason;
    this.retryable = params.retryable ?? false;
    this.status = params.status;
    this.retryAfterMs = params.retryAfterMs;
  }
}

// ── Classify any error ──────────────────────────────────────────────────────

/**
 * Wrap or classify any thrown value into a TalonError.
 * Call this at module boundaries (backend catch, bridge catch) to convert
 * raw errors into typed ones that callers can switch on.
 */
export function classify(err: unknown): TalonError {
  if (err instanceof TalonError) return err;

  let msg: string;
  if (err instanceof Error) msg = err.message;
  else if (typeof err === "string") msg = err;
  else {
    try {
      msg = String(err);
    } catch {
      msg = "[non-stringifiable error]";
    }
  }
  const cause = err instanceof Error ? err : undefined;

  // Extract HTTP status if present
  const statusMatch = msg.match(/\b([2-5]\d{2})\b/);
  const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

  // Rate limit
  if (/rate.?limit|429|too many requests/i.test(msg)) {
    const retryMatch = msg.match(/retry.?after[:\s]*(\d+)/i);
    const retryAfterMs = retryMatch
      ? Math.min(parseInt(retryMatch[1], 10) * 1000, 300_000)
      : 60_000;
    return new TalonError(msg, {
      reason: "rate_limit",
      retryable: true,
      status: status ?? 429,
      retryAfterMs,
      cause,
    });
  }

  // Overloaded / capacity
  if (/overloaded|503|capacity/i.test(msg)) {
    return new TalonError(msg, {
      reason: "overloaded",
      retryable: true,
      status: status ?? 503,
      retryAfterMs: 5_000,
      cause,
    });
  }

  // Network errors
  if (
    /network|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|fetch failed|connection reset/i.test(
      msg,
    )
  ) {
    return new TalonError(msg, {
      reason: "network",
      retryable: true,
      retryAfterMs: 2_000,
      cause,
    });
  }

  // Session expired
  if (/session|expired|invalid.*resume/i.test(msg)) {
    return new TalonError(msg, {
      reason: "session_expired",
      retryable: false,
      cause,
    });
  }

  // Context length / overflow
  if (/context.*length|too.*long|token.*limit|overflow/i.test(msg)) {
    return new TalonError(msg, {
      reason: "context_length",
      retryable: false,
      cause,
    });
  }

  // Auth
  if (/authentication|unauthorized|401|api.?key/i.test(msg)) {
    return new TalonError(msg, {
      reason: "auth",
      retryable: false,
      status: status ?? 401,
      cause,
    });
  }

  // Bad request (don't retry)
  if (status === 400) {
    return new TalonError(msg, {
      reason: "bad_request",
      retryable: false,
      status: 400,
      cause,
    });
  }

  // Forbidden (don't retry)
  if (status === 403) {
    return new TalonError(msg, {
      reason: "forbidden",
      retryable: false,
      status: 403,
      cause,
    });
  }

  // Server errors (5xx) are generally retryable
  if (status && status >= 500) {
    return new TalonError(msg, {
      reason: "overloaded",
      retryable: true,
      status,
      retryAfterMs: 2_000,
      cause,
    });
  }

  // Unknown
  return new TalonError(msg, {
    reason: "unknown",
    retryable: false,
    status,
    cause,
  });
}

// ── User-friendly messages ──────────────────────────────────────────────────

const FRIENDLY_MESSAGES: Record<ErrorReason, string> = {
  rate_limit: "Rate limited. Try again in a moment.",
  overloaded: "Claude is busy right now. Retrying with a faster model...",
  network: "Connection issue. Retrying shortly.",
  auth: "API key error. Bot operator: check your Claude credentials.",
  context_length:
    "Conversation too long for the context window. Use /reset to start fresh.",
  session_expired: "Session expired. Retrying automatically...",
  bad_request: "Something went wrong. Try /reset if this keeps happening.",
  forbidden: "Permission denied for this action.",
  telegram_api: "Telegram API error. Try again.",
  unknown: "Something went wrong. Try again or /reset.",
};

/**
 * Get a user-friendly error message. For rate limits, includes retry timing.
 */
export function friendlyMessage(err: unknown): string {
  const classified = err instanceof TalonError ? err : classify(err);

  if (classified.reason === "rate_limit" && classified.retryAfterMs) {
    const seconds = Math.ceil(classified.retryAfterMs / 1000);
    return `Rate limited. Try again in ${seconds} seconds.`;
  }

  // Session expired messages are already user-friendly from the backend
  if (classified.reason === "session_expired") {
    return classified.message;
  }

  return FRIENDLY_MESSAGES[classified.reason];
}
