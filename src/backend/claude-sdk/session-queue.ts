/**
 * Per-chat session queue with mid-flight message injection.
 *
 * Keeps a single Claude Agent SDK Query alive per chat, fed by a streaming
 * input iterable. New user messages arriving while the model is mid-turn
 * (running tools, generating text) get pushed onto the iterable so the SDK
 * processes them as the next conversational turn — no waiting for the
 * current run to finish.
 *
 * Each turn (one user message → its tool/text/result cycle) gets its own
 * Promise<QueryResult> and its own callbacks. The session iterator routes
 * stream events to whichever turn is currently active.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { rebuildSystemPrompt } from "../../util/config.js";
import { getPluginPromptAdditions } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { formatFullDatetime } from "../../util/time.js";

import type { QueryParams, QueryResult } from "../../core/types.js";
import { getConfig } from "./state.js";
import { buildSdkOptions } from "./options.js";
import {
  createStreamState,
  isSystemInit,
  isStreamEvent,
  isAssistant,
  isResult,
  processStreamDelta,
  processAssistantMessage,
  processResultMessage,
  type StreamState,
} from "./stream.js";

// ── AsyncMessageQueue ───────────────────────────────────────────────────────
// A push-based AsyncIterable. Producers call push(); the iterable yields each
// pushed item to a consumer. close() ends the iteration cleanly.

export class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((value: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): boolean {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) {
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: undefined as never, done: true });
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  size(): number {
    return this.items.length;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.items.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

// ── Per-turn state ─────────────────────────────────────────────────────────

type PendingTurn = {
  /** Unique id (for logging only) */
  id: string;
  /** Original parameters from the caller */
  params: QueryParams;
  /** Turn-specific stream state (one per turn — fresh tokens, tools, text) */
  state: StreamState;
  /** Wall-clock start (for durationMs reporting) */
  startedAt: number;
  /** Promise resolution */
  resolve: (result: QueryResult) => void;
  reject: (err: unknown) => void;
};

// ── Per-chat session ───────────────────────────────────────────────────────

type ChatSession = {
  chatId: string;
  /** The live Query — null only momentarily during creation */
  query: Query;
  /** Pushed-input iterable feeding the Query */
  inputQueue: AsyncMessageQueue<SDKUserMessage>;
  /** Currently in-flight turn (the one whose callbacks are active) */
  current: PendingTurn | null;
  /** Pending turns queued behind current */
  pending: PendingTurn[];
  /** Active model id used to scope modelUsage extraction */
  activeModel: string;
  /** Promise that resolves when the iteration loop finishes */
  iterDone: Promise<void>;
  /** Set true when an unrecoverable error occurs — no new turns accepted */
  failed: boolean;
  /** Idle timer — closes the session after IDLE_MS of no activity */
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const sessions = new Map<string, ChatSession>();
let turnSeq = 0;

/**
 * How long to keep a session alive (subprocess + MCP servers) after the last
 * turn completes. New messages arriving within this window get injected into
 * the existing conversation; messages after it start a fresh session.
 *
 * Trade-off: higher = better latency on follow-up messages, higher idle
 * resource cost (one subprocess + MCP servers per chat); lower = opposite.
 */
const IDLE_MS = 5 * 60 * 1000; // 5 minutes

// ── Public API ─────────────────────────────────────────────────────────────

/** Get the live SDK Query for a chat, if any. Used by refreshMcpServers etc. */
export function getActiveQuery(chatId: string): Query | undefined {
  return sessions.get(chatId)?.query;
}

/** Number of in-flight + queued turns for a chat (0 if no session). */
export function getQueuedCount(chatId: string): number {
  const s = sessions.get(chatId);
  if (!s) return 0;
  return (s.current ? 1 : 0) + s.pending.length;
}

/**
 * Submit a user message. If a session is already running for this chat,
 * the message gets injected into the live Query as the next turn. Otherwise
 * a fresh session is started.
 *
 * Returns a promise resolved with the QueryResult for THIS message's turn
 * (not the whole session).
 */
export function submitMessage(params: QueryParams): Promise<QueryResult> {
  return new Promise<QueryResult>((resolve, reject) => {
    const turn: PendingTurn = {
      id: `t${++turnSeq}`,
      params,
      state: createStreamState(),
      startedAt: Date.now(),
      resolve,
      reject,
    };

    const existing = sessions.get(params.chatId);
    if (existing && !existing.failed && !existing.inputQueue.isClosed()) {
      enqueueTurn(existing, turn);
      return;
    }

    // No session (or previous one failed) — start a fresh one
    try {
      const session = startSession(params.chatId);
      enqueueTurn(session, turn);
    } catch (err) {
      reject(err);
    }
  });
}

// ── Internal: session lifecycle ────────────────────────────────────────────

function startSession(chatId: string): ChatSession {
  const config = getConfig();
  const sessionMeta = getSession(chatId);
  // Rebuild system prompt on first turn of a new/reset session so identity,
  // memory, and workspace listing are fresh.
  if (sessionMeta.turns === 0) {
    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  const { options, activeModel } = buildSdkOptions(chatId);
  const inputQueue = new AsyncMessageQueue<SDKUserMessage>();

  const qi = query({ prompt: inputQueue, options });

  // Build the session object first so iterate() can reference it via the map
  const session: ChatSession = {
    chatId,
    query: qi,
    inputQueue,
    current: null,
    pending: [],
    activeModel,
    iterDone: Promise.resolve(),
    failed: false,
    idleTimer: null,
  };
  sessions.set(chatId, session);

  // Capture sdkModel for processResultMessage (options.model may differ from activeModel)
  const sdkModel = options.model ?? activeModel;
  session.iterDone = iterate(session, sdkModel);
  return session;
}

function enqueueTurn(session: ChatSession, turn: PendingTurn): void {
  // Cancel any pending idle close — we're active again
  cancelIdleTimer(session);

  const text = formatPromptText(turn.params);
  const userMsg = buildSdkUserMessage(text);

  log(
    "agent",
    `[${session.chatId}] <- (${turn.params.text.length} chars)` +
      (session.current ? ` [queued]` : ``),
  );
  traceMessage(session.chatId, "in", turn.params.text, {
    senderName: turn.params.senderName,
    isGroup: turn.params.isGroup,
  });

  if (!session.current) {
    session.current = turn;
  } else {
    session.pending.push(turn);
  }

  const ok = session.inputQueue.push(userMsg);
  if (!ok) {
    // Queue closed between checks — fail the turn so the caller can retry
    failTurn(turn, new Error("session input closed before message accepted"));
    if (session.current === turn) {
      session.current = session.pending.shift() ?? null;
    } else {
      const idx = session.pending.indexOf(turn);
      if (idx >= 0) session.pending.splice(idx, 1);
    }
  }
}

function formatPromptText(params: QueryParams): string {
  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const nowTag = `[${formatFullDatetime()}]`;
  return params.isGroup
    ? `${nowTag} [${params.senderName}]${msgIdHint}: ${params.text}`
    : `${nowTag}${msgIdHint} ${params.text}`;
}

/**
 * Build an SDKUserMessage in the exact shape the SDK CLI subprocess expects.
 * Mirrors what `unstable_v2_createSession.send()` produces internally:
 * content as an array of typed blocks, plus a placeholder session_id (the
 * SDK fills in the real one when forwarding to the model).
 */
function buildSdkUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

// ── Idle timer ─────────────────────────────────────────────────────────────
// When a turn finishes and nothing is queued, start an idle timer. If a new
// message arrives before it fires, cancel it and inject. If the timer fires,
// close the input stream and let the SDK subprocess exit cleanly.

function startIdleTimer(session: ChatSession): void {
  cancelIdleTimer(session);
  session.idleTimer = setTimeout(() => {
    // Re-check: a message might have arrived in the same macrotask
    if (session.current || session.pending.length > 0 || session.failed) return;
    log(
      "agent",
      `[${session.chatId}] session idle for ${IDLE_MS / 1000}s, closing`,
    );
    session.inputQueue.close();
  }, IDLE_MS);
  // Don't keep the process alive on this timer
  if (
    session.idleTimer &&
    typeof (session.idleTimer as { unref?: () => void }).unref === "function"
  ) {
    (session.idleTimer as { unref: () => void }).unref();
  }
}

function cancelIdleTimer(session: ChatSession): void {
  if (session.idleTimer) {
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}

// ── Iteration loop ─────────────────────────────────────────────────────────

async function iterate(session: ChatSession, sdkModel: string): Promise<void> {
  const { chatId, query: qi } = session;

  try {
    for await (const message of qi) {
      const turn = session.current;
      if (!turn) {
        // Stray message after current turn settled but before next dequeued —
        // shouldn't happen in practice, but skip defensively.
        continue;
      }

      // Session ID is set once per Claude session; record it on every init so
      // we capture it even if it arrives mid-stream (e.g. resume).
      if (isSystemInit(message)) {
        turn.state.newSessionId = message.session_id;
        continue;
      }

      if (isStreamEvent(message)) {
        processStreamDelta(message, turn.state, turn.params.onStreamDelta);
        continue;
      }

      if (isAssistant(message)) {
        const result = processAssistantMessage(message, turn.state);

        for (const tool of result.tools) {
          incrementCounter(`tool_calls.${tool.name}`);
          if (turn.params.onToolUse) {
            try {
              turn.params.onToolUse(tool.name, tool.input);
            } catch {
              /* non-fatal */
            }
          }
        }

        if (turn.params.onTextBlock) {
          for (const text of result.progressTexts) {
            try {
              await turn.params.onTextBlock(text);
            } catch {
              /* non-fatal — don't abort the stream loop */
            }
          }
        }
        continue;
      }

      if (isResult(message)) {
        processResultMessage(message, turn.state, sdkModel);
        completeTurn(session, turn);
        // Don't close the queue when we drain — keep the SDK subprocess + MCP
        // servers alive so a follow-up message gets injected as a new turn
        // in the SAME conversation. The idle timer eventually closes it.
        if (!session.current && session.pending.length === 0) {
          startIdleTimer(session);
        }
        continue;
      }
    }
  } catch (err) {
    handleSessionError(session, err);
  } finally {
    cancelIdleTimer(session);
    // Always tear down the session record so the next message starts fresh
    if (sessions.get(chatId) === session) {
      sessions.delete(chatId);
    }
    // Any turns that were still pending at exit must be rejected
    if (session.current) {
      failTurn(
        session.current,
        new Error("session ended before turn completed"),
      );
      session.current = null;
    }
    while (session.pending.length > 0) {
      const t = session.pending.shift()!;
      failTurn(t, new Error("session ended before turn started"));
    }
  }
}

function completeTurn(session: ChatSession, turn: PendingTurn): void {
  const { chatId } = session;
  const durationMs = Date.now() - turn.startedAt;
  const state = turn.state;

  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");
  if (state.newSessionId) setSessionId(chatId, state.newSessionId);
  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    durationMs,
    model: session.activeModel,
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow,
    numApiCalls: state.numApiCalls,
  });

  // Set a descriptive session name from the first message
  const sessionMeta = getSession(chatId);
  if (sessionMeta.turns === 1 && turn.params.text) {
    const cleanText = turn.params.text
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\[msg_id:\d+\]\s*/g, "")
      .trim();
    if (cleanText) {
      const name =
        cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText;
      setSessionName(chatId, name);
    }
  }

  state.allResponseText += state.currentBlockText;
  const totalPrompt =
    state.sdkInputTokens + state.sdkCacheRead + state.sdkCacheWrite;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((state.sdkCacheRead / totalPrompt) * 100) : 0;

  log(
    "agent",
    `[${chatId}] -> (${durationMs}ms, in=${state.sdkInputTokens} out=${state.sdkOutputTokens} cache=${cacheHitPct}%` +
      `${state.toolCalls > 0 ? ` tools=${state.toolCalls}` : ""})`,
  );
  traceMessage(chatId, "out", state.allResponseText, {
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    toolCalls: state.toolCalls,
    model: session.activeModel,
  });

  turn.resolve({
    text: state.allResponseText.trim(),
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
  });

  // Advance to the next pending turn, if any
  session.current = session.pending.shift() ?? null;
}

function failTurn(turn: PendingTurn, err: unknown): void {
  try {
    turn.reject(err);
  } catch {
    /* shouldn't happen — promise reject is idempotent */
  }
}

function handleSessionError(session: ChatSession, err: unknown): void {
  session.failed = true;
  const msg = err instanceof Error ? err.message : String(err);
  logError("agent", `[${session.chatId}] SDK error: ${msg}`);
  incrementCounter("errors.session");
  // Mark queue closed so subsequent messages start a fresh session
  session.inputQueue.close();
  logWarn(
    "agent",
    `[${session.chatId}] Session aborted; ${1 + session.pending.length} pending turn(s) will be rejected`,
  );
}
