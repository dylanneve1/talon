/**
 * The agent-host seam — the contract between the daemon and the process
 * that hosts the Claude Agent SDK.
 *
 * `docs/agent-host-sidecar.md` Phase 1. Today the SDK runs inside the
 * daemon: an OOM or an SDK bug takes down every frontend with it. The
 * sidecar moves it into its own process, and this file is the boundary
 * that move happens across — written first, on purpose, so Phase 2 is a
 * transport swap rather than a redesign.
 *
 * Two halves:
 *
 *   - **The wire vocabulary.** `HostRequest` / `HostReply` / `HostEvent` /
 *     `HostNotice` are the NDJSON messages of the design's protocol
 *     table, one TypeScript type per row, plus `parseHostMessage` /
 *     `serializeHostMessage` — the codec both sides run, replayed against
 *     `protocol/fixtures/agent-host_v1.json` in
 *     `src/__tests__/agent-host-protocol.test.ts`.
 *   - **The client.** `AgentHostClient` is what the daemon holds. Phase 1
 *     ships one implementation (`backend/claude-sdk/host/in-process.ts`,
 *     a direct call-through); Phase 2 adds a second that speaks the
 *     messages above over a child process's stdio. The `Backend` object
 *     the rest of the daemon sees is identical either way.
 *
 * Layering: the interface and the codec live in `core/` because `core/`
 * may not import `backend/` (depcruise `core-not-to-backend`). Every
 * implementation lives under `backend/`.
 *
 * Wire types vs client types
 * ──────────────────────────
 * They are deliberately not the same types. Two client arguments do not
 * survive a process boundary and the wire shapes say so:
 *
 *   - `OneShotAgentParams` carries an `AbortController` and an
 *     `appendLog` callback. `HostOneShotParams` is the serialisable
 *     subset; Phase 2 maps `appendLog` onto `log` notices and the
 *     abort onto an `interrupt`-shaped request.
 *   - `hello.config` is the `claude-sdk` slice of `TalonConfig` as
 *     JSON. The in-process client takes the real `TalonConfig` object.
 *
 * Forward compatibility: unknown fields on a known message type are
 * additive evolution and must be preserved, never rejected. An unknown
 * `type` parses to `HostUnknown`, which callers log and drop — the codec
 * never throws, so one bad line can't kill a turn or the loop reading it.
 */

import type { AgentEvent, AgentError } from "./events.js";
import type { ChatRunParams, PlanUsage } from "./capabilities.js";
import type {
  OneShotAgentParams,
  OneShotUsage,
  ReasoningEffortLevel,
  UnifiedModelInfo,
} from "../types.js";

/** Wire-format version. Bump only on a breaking change — prefer additive. */
export const AGENT_HOST_PROTOCOL_VERSION = 1;

// ── Shared payload shapes ───────────────────────────────────────────────────

/**
 * The serialisable half of `OneShotAgentParams`. `abortController` and
 * `appendLog` are host-local concerns (see the file header); everything
 * else is exactly what a background run needs.
 *
 * Unexported on purpose — it is reachable as
 * `Extract<HostRequest, { type: "one_shot" }>["params"]`, and a second
 * name for the same shape is a thing to keep in sync for nothing.
 */
interface HostOneShotParams {
  prompt: string;
  systemPrompt: string;
  workspace: string;
  model: string;
  reasoningEffort?: ReasoningEffortLevel;
  contextLabel: string;
}

/**
 * The MCP diff `set_mcp_servers` / `refresh_tools` answer with — the same
 * shape `ToolRuntime.refreshTools` returns to the dispatcher today.
 */
export interface HostToolRefresh {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}

/**
 * What the host knows about one chat's session. `sessionId` is the SDK's
 * resume handle; the context figures are the ones `warm_session` populates
 * — which is why this query exists at all. In-process those numbers land
 * in the daemon's own session store; across a process boundary they have
 * to be asked for.
 */
export interface HostSessionInfo {
  chatId: string;
  sessionId?: string;
  turns: number;
  contextTokens: number;
  contextWindow: number;
}

/** `ready`'s payload — the handshake answer, minus the envelope. */
export interface HostReadyInfo {
  protocol: number;
  /** The host build's version. */
  host: string;
  /**
   * The Claude Agent SDK version the host is running. Absent in-process,
   * where there is no separately-pinned SDK to report (Phase 4 gives the
   * host its own `package.json`).
   */
  sdk?: string;
}

// ── Daemon → host ───────────────────────────────────────────────────────────

/**
 * Every request the daemon can send. Each carries an `id`; the reply
 * carries the same `id`. Turn-shaped requests (`run_turn`, `one_shot`)
 * additionally carry a `runId`, which every streamed `event` repeats.
 */
export type HostRequest =
  | {
      type: "hello";
      id: string;
      protocol: number;
      /** The daemon's version, for the host's compatibility log line. */
      daemon: string;
      /** The `claude-sdk` slice of `TalonConfig`, as JSON. */
      config: Record<string, unknown>;
    }
  | { type: "run_turn"; id: string; runId: string; params: ChatRunParams }
  | { type: "interrupt"; id: string; chatId: string }
  | { type: "one_shot"; id: string; runId: string; params: HostOneShotParams }
  | { type: "warm_session"; id: string; chatId: string }
  | {
      type: "set_mcp_servers";
      id: string;
      chatId: string;
      /** SDK `McpServerConfig` map, opaque here — the host hands it to the SDK. */
      servers: Record<string, unknown>;
    }
  | { type: "refresh_tools"; id: string; chatId: string }
  | { type: "list_models"; id: string; filter?: "free" | "all" }
  | { type: "plan_usage"; id: string }
  | { type: "session_info"; id: string; chatId: string }
  | { type: "reset_session"; id: string; chatId: string }
  | { type: "shutdown"; id: string };

// ── Host → daemon ───────────────────────────────────────────────────────────

/**
 * Every reply. `ok` is the generic ack, with one optional field per
 * request that has something to say back; the queries get their own
 * types so a reply is never ambiguous with the request that asked for it
 * (`list_models` → `models`, `plan_usage` → `usage`, `session_info` →
 * `session`).
 */
export type HostReply =
  | ({ type: "ready"; id: string } & HostReadyInfo)
  | {
      type: "ok";
      id: string;
      /** `interrupt` — a running turn was found and signalled. */
      interrupted?: boolean;
      /** `set_mcp_servers` / `refresh_tools` — `null` when the chat has no live query. */
      tools?: HostToolRefresh | null;
      /** `reset_session` — host-side per-chat state was dropped. */
      cleared?: boolean;
    }
  | { type: "run_done"; id: string; runId: string; usage?: OneShotUsage }
  | { type: "error"; id: string; error: AgentError }
  | { type: "models"; id: string; models: UnifiedModelInfo[]; total: number }
  | { type: "usage"; id: string; usage?: PlanUsage }
  | { type: "session"; id: string; session?: HostSessionInfo }
  | { type: "bye"; id: string };

/**
 * One turn event. The `AgentEvent` union is unchanged and unwrapped —
 * that is the whole point of the seam: the daemon's consumers switch on
 * `event.type` exactly as they do against an in-process backend.
 */
export interface HostEvent {
  type: "event";
  runId: string;
  event: AgentEvent;
}

/**
 * Unsolicited host → daemon traffic, carrying no `id` because nothing
 * asked for it. `log` is the host's stdout logging (stderr is tailed by
 * the supervisor like an MCP child's); `metric` forwards the `cache.*`
 * and turn counters the host records so the daemon's rollups are
 * unchanged by the move.
 */
export type HostNotice =
  | {
      type: "log";
      level: "debug" | "info" | "warn" | "error";
      component: string;
      msg: string;
    }
  | { type: "metric"; name: string; value: number };

/** Anything that can appear on the wire, either direction. */
export type HostMessage = HostRequest | HostReply | HostEvent | HostNotice;

/**
 * A line the codec could not place. Never thrown — returned, so the
 * reader logs it and drops it. `raw` is whatever came off the wire so
 * the log can say what was skipped.
 */
export interface HostUnknown {
  type: "unknown";
  reason: "malformed_json" | "not_an_object" | "unknown_type";
  raw: unknown;
}

// ── The type registry the codec discriminates on ────────────────────────────

/**
 * `satisfies` rejects typos here; the `AssertNever` checks in
 * `src/__tests__/agent-host-protocol.test.ts` fail to compile when a new
 * member joins a union without being listed — which forces a fixture
 * sample too, because the fixture test asserts these lists exactly.
 */
export const HOST_REQUEST_TYPES = [
  "hello",
  "run_turn",
  "interrupt",
  "one_shot",
  "warm_session",
  "set_mcp_servers",
  "refresh_tools",
  "list_models",
  "plan_usage",
  "session_info",
  "reset_session",
  "shutdown",
] as const satisfies readonly HostRequest["type"][];

export const HOST_REPLY_TYPES = [
  "ready",
  "ok",
  "run_done",
  "error",
  "models",
  "usage",
  "session",
  "bye",
] as const satisfies readonly HostReply["type"][];

export const HOST_NOTICE_TYPES = [
  "log",
  "metric",
] as const satisfies readonly HostNotice["type"][];

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>([
  ...HOST_REQUEST_TYPES,
  ...HOST_REPLY_TYPES,
  ...HOST_NOTICE_TYPES,
  "event",
]);

// ── Codec ───────────────────────────────────────────────────────────────────

/**
 * Render one message as its NDJSON line — no trailing newline, so the
 * transport owns the framing. Symmetric with `parseHostMessage`.
 */
export function serializeHostMessage(message: HostMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse one NDJSON line. Total: malformed JSON, non-objects and unknown
 * `type`s all come back as `HostUnknown` rather than throwing, because a
 * single bad line from a newer peer must not take down the read loop.
 *
 * Unknown FIELDS on a known type are preserved as-is — additive evolution
 * is the protocol's normal path, and dropping them here would silently
 * downgrade a message the other end meant to send.
 */
export function parseHostMessage(line: string): HostMessage | HostUnknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { type: "unknown", reason: "malformed_json", raw: line };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { type: "unknown", reason: "not_an_object", raw: parsed };
  }
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) {
    return { type: "unknown", reason: "unknown_type", raw: parsed };
  }
  return parsed as HostMessage;
}

// ── The client the daemon holds ─────────────────────────────────────────────

/**
 * What the daemon calls instead of reaching into `backend/claude-sdk/`
 * directly. One method per protocol-table row, with the signatures the
 * claude-sdk `BackendFactory` actually uses today — no capability the
 * backend does not have is invented here.
 *
 * Bound into the `Backend` object in Phase 1: `hello`, `runTurn`,
 * `interrupt`, `runOneShot`, `warmSession`, `refreshTools`, `listModels`,
 * `planUsage`. Defined-but-unbound: `setMcpServers` (the primitive
 * `refreshTools` is built from), `sessionInfo` and `resetSession` (the
 * Claude SDK backend exposes neither a `getSessionSnapshot` nor a
 * `resetChat` slot, and Phase 1 may not change the `Backend` object), and
 * `shutdown` (nothing to stop until there is a process).
 */
export interface AgentHostClient {
  /**
   * Handshake + initialisation. In-process this is `initAgent(config)`;
   * across a process it is `hello` → `ready`. Must resolve before any
   * other call — model discovery happens here.
   */
  hello(): Promise<HostReadyInfo>;

  /**
   * One chat turn. The returned stream is the canonical `AgentEvent`
   * sequence, `run_started` first and `completed`/`error` last, exactly
   * as `ChatBackend.runChatTurn` promises.
   */
  runTurn(params: ChatRunParams): AsyncIterable<AgentEvent>;

  /** Best-effort stop of a chat's in-flight turn. `true` when one was signalled. */
  interrupt(chatId: string): Promise<boolean>;

  /**
   * One background run (heartbeat / dream / cron). Resolves with the
   * run's usage when the SDK reports it.
   *
   * Callback-shaped, not a stream: `OneShotAgentParams.appendLog` is how
   * the background producers write their markdown logs today, and turning
   * that into an event stream would be a behaviour change, not a seam.
   * The design's "stream as above" row is Phase 2's problem, and the wire
   * type (`HostOneShotParams`) already records what has to give.
   */
  runOneShot(params: OneShotAgentParams): Promise<OneShotUsage | void>;

  /** Cold-start hint: spawn a throwaway query to prime the context figures. */
  warmSession(chatId: string): Promise<void>;

  /**
   * Install an MCP server set on the chat's live query. `null` when the
   * chat has no query in flight. The primitive `refreshTools` is built
   * from; the two-phase teardown lives in the host, not the caller,
   * because `Query` handles do not cross a process boundary.
   */
  setMcpServers(
    chatId: string,
    servers: Record<string, unknown>,
  ): Promise<HostToolRefresh | null>;

  /** Re-derive the chat's MCP config from the live plugin registry. */
  refreshTools(chatId: string): Promise<HostToolRefresh | null>;

  /**
   * The model catalog, as the host discovered it from the SDK. The other
   * seven `ModelCatalog` members are pure daemon-side formatting over
   * `core/models/catalog.ts`, which `hello` populates — see
   * `docs/agent-host-sidecar.md` Phase 1.
   */
  listModels(
    filter?: "free" | "all",
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;

  /** Subscription rate-limit windows for `/status`. */
  planUsage(): Promise<PlanUsage | undefined>;

  /** What the host knows about a chat's session, including the context figures. */
  sessionInfo(chatId: string): Promise<HostSessionInfo | undefined>;

  /** Drop the host's per-chat state. `true` when there was something to drop. */
  resetSession(chatId: string): Promise<boolean>;

  /** Drain in-flight turns, then stop. A no-op while the host is in-process. */
  shutdown(): Promise<void>;
}
