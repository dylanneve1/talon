/**
 * Typed error classification.
 *
 * One place to classify errors. Every module reads `err.reason` instead
 * of regex-matching error messages. Inspired by OpenClaw's FailoverError.
 */

// ── Error reasons ───────────────────────────────────────────────────────────

export type ErrorReason =
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
  readonly code?: string;
  readonly metadata: Record<string, unknown>;

  constructor(
    message: string,
    params: {
      reason: ErrorReason;
      retryable?: boolean;
      status?: number;
      retryAfterMs?: number;
      code?: string;
      metadata?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "TalonError";
    this.reason = params.reason;
    this.retryable = params.retryable ?? false;
    this.status = params.status;
    this.retryAfterMs = params.retryAfterMs;
    this.code = params.code;
    this.metadata = params.metadata ?? {};
  }
}

// ── Safe extraction helpers ─────────────────────────────────────────────────

type ErrorLike = Record<string, unknown>;

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const RETRY_AFTER_CAP_MS = 300_000;

function isRecord(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

function tryString(value: unknown): string | undefined {
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

/**
 * JSON-stringify unknown values without throwing on circular references,
 * throwing getters, functions, symbols, or excessively deep objects.
 */
export function safeStringify(
  value: unknown,
  maxDepth = 4,
): string | undefined {
  const seen = new WeakSet<object>();

  function normalize(input: unknown, depth: number): unknown {
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "number" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "bigint") return input.toString();
    if (typeof input === "symbol") return input.toString();
    if (typeof input === "function") return "[function]";
    if (!isRecord(input)) return tryString(input);
    if (seen.has(input)) return "[circular]";
    if (depth >= maxDepth) return "[max-depth]";

    seen.add(input);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      try {
        out[key] = normalize(input[key], depth + 1);
      } catch (err) {
        out[key] = `[unreadable: ${tryString(err) ?? "unknown"}]`;
      }
    }
    seen.delete(input);
    return out;
  }

  try {
    const serialized = JSON.stringify(normalize(value, 0));
    return serialized === undefined ? tryString(value) : serialized;
  } catch {
    return tryString(value);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;

  if (isRecord(err)) {
    const message = err.message;
    if (typeof message === "string" && message.trim()) return message;
    const error = err.error;
    if (typeof error === "string" && error.trim()) return error;
    const serialized = safeStringify(err);
    if (serialized && serialized !== "{}") return serialized;
  }

  return tryString(err) ?? "[non-stringifiable error]";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readPath(source: unknown, path: string[]): unknown {
  let current = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function extractStatus(err: unknown, msg: string): number | undefined {
  const candidates = [
    readPath(err, ["status"]),
    readPath(err, ["statusCode"]),
    readPath(err, ["status_code"]),
    readPath(err, ["response", "status"]),
    readPath(err, ["response", "statusCode"]),
    readPath(err, ["cause", "status"]),
    readPath(err, ["cause", "statusCode"]),
  ];

  for (const candidate of candidates) {
    const status = readNumber(candidate);
    if (status && status >= 200 && status <= 599) return status;
  }

  const statusMatch = msg.match(/\b([2-5]\d{2})\b/);
  return statusMatch ? parseInt(statusMatch[1], 10) : undefined;
}

function extractCode(err: unknown): string | undefined {
  const candidates = [
    readPath(err, ["code"]),
    readPath(err, ["name"]),
    readPath(err, ["cause", "code"]),
    readPath(err, ["response", "code"]),
  ];
  for (const candidate of candidates) {
    const code = readString(candidate);
    if (code) return code;
  }
  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();

  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      const value = (headers as { get(name: string): unknown }).get(name);
      const header = readString(value);
      if (header) return header;
    } catch {
      return undefined;
    }
  }

  if (!isRecord(headers)) return undefined;
  const direct = readString(headers[name]) ?? readString(headers[lowerName]);
  if (direct) return direct;

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return readString(value);
  }
  return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, Math.ceil(seconds * 1000)), RETRY_AFTER_CAP_MS);
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return Math.min(Math.max(0, timestamp - Date.now()), RETRY_AFTER_CAP_MS);
  }

  const match = trimmed.match(/(\d+)/);
  if (!match) return undefined;
  return Math.min(parseInt(match[1], 10) * 1000, RETRY_AFTER_CAP_MS);
}

function extractRetryAfterMs(err: unknown, msg: string): number | undefined {
  const retryAfterHeader =
    readHeader(readPath(err, ["headers"]), "retry-after") ??
    readHeader(readPath(err, ["response", "headers"]), "retry-after");
  const retryAfterMsHeader =
    readHeader(readPath(err, ["headers"]), "retry-after-ms") ??
    readHeader(readPath(err, ["response", "headers"]), "retry-after-ms");

  const retryAfterMsNumber = readNumber(retryAfterMsHeader);
  if (retryAfterMsNumber !== undefined) {
    return Math.min(Math.max(0, retryAfterMsNumber), RETRY_AFTER_CAP_MS);
  }

  const headerDelay = parseRetryAfter(retryAfterHeader);
  if (headerDelay !== undefined) return headerDelay;

  const retryMatch = msg.match(/retry[-_\s]?after[:\s]*(\d+)/i);
  return retryMatch
    ? Math.min(parseInt(retryMatch[1], 10) * 1000, RETRY_AFTER_CAP_MS)
    : undefined;
}

function metadata(status: number | undefined, code: string | undefined) {
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

// ── Classify any error ──────────────────────────────────────────────────────

/**
 * Wrap or classify any thrown value into a TalonError.
 * Call this at module boundaries (backend catch, bridge catch) to convert
 * raw errors into typed ones that callers can switch on.
 */
export function classify(err: unknown): TalonError {
  if (err instanceof TalonError) return err;

  const msg = errorMessage(err);
  const cause = err instanceof Error ? err : undefined;
  const status = extractStatus(err, msg);
  const code = extractCode(err);
  const retryAfterMs = extractRetryAfterMs(err, msg);

  // Rate limit
  if (status === 429 || /rate.?limit|429|too many requests/i.test(msg)) {
    return new TalonError(msg, {
      reason: "rate_limit",
      retryable: true,
      status: status ?? 429,
      retryAfterMs: retryAfterMs ?? 60_000,
      code,
      metadata: metadata(status ?? 429, code),
      cause,
    });
  }

  // Overloaded / capacity
  if (/overloaded|503|capacity/i.test(msg) || status === 503) {
    return new TalonError(msg, {
      reason: "overloaded",
      retryable: true,
      status: status ?? 503,
      retryAfterMs: retryAfterMs ?? 5_000,
      code,
      metadata: metadata(status ?? 503, code),
      cause,
    });
  }

  // Network errors
  if (
    (code && NETWORK_ERROR_CODES.has(code.toUpperCase())) ||
    status === 408 ||
    /network|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|fetch failed|connection reset/i.test(
      msg,
    )
  ) {
    return new TalonError(msg, {
      reason: "network",
      retryable: true,
      status,
      retryAfterMs: retryAfterMs ?? 2_000,
      code,
      metadata: metadata(status, code),
      cause,
    });
  }

  // Session expired
  if (/session|expired|invalid.*resume/i.test(msg)) {
    return new TalonError(msg, {
      reason: "session_expired",
      retryable: false,
      status,
      code,
      metadata: metadata(status, code),
      cause,
    });
  }

  // Context length / overflow
  if (/context.*length|too.*long|token.*limit|overflow/i.test(msg)) {
    return new TalonError(msg, {
      reason: "context_length",
      retryable: false,
      status,
      code,
      metadata: metadata(status, code),
      cause,
    });
  }

  // Auth
  if (/authentication|unauthorized|401|api.?key/i.test(msg)) {
    return new TalonError(msg, {
      reason: "auth",
      retryable: false,
      status: status ?? 401,
      code,
      metadata: metadata(status ?? 401, code),
      cause,
    });
  }

  // Bad request (don't retry)
  if (status === 400) {
    return new TalonError(msg, {
      reason: "bad_request",
      retryable: false,
      status: 400,
      code,
      metadata: metadata(400, code),
      cause,
    });
  }

  // Forbidden (don't retry)
  if (status === 403) {
    return new TalonError(msg, {
      reason: "forbidden",
      retryable: false,
      status: 403,
      code,
      metadata: metadata(403, code),
      cause,
    });
  }

  // Telegram / Bot API errors (usually action-specific and non-retryable here)
  if (/telegram|grammy|bot api/i.test(msg)) {
    return new TalonError(msg, {
      reason: "telegram_api",
      retryable: false,
      status,
      code,
      metadata: metadata(status, code),
      cause,
    });
  }

  // Server errors (5xx) are generally retryable
  if (status && status >= 500) {
    return new TalonError(msg, {
      reason: "overloaded",
      retryable: true,
      status,
      retryAfterMs: retryAfterMs ?? 2_000,
      code,
      metadata: metadata(status, code),
      cause,
    });
  }

  // Unknown
  return new TalonError(msg, {
    reason: "unknown",
    retryable: false,
    status,
    code,
    metadata: metadata(status, code),
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
