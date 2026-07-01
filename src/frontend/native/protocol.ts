/**
 * Talon Client Bridge Protocol (v1).
 *
 * The stable, client-agnostic contract between a Talon daemon running the
 * `native` frontend and ANY GUI client: the bundled Electron companion app
 * (apps/desktop), and future clients (Android, iOS, web). Transport is plain
 * HTTP + Server-Sent Events with JSON bodies, so a client written in any
 * language can speak it against `http://<host>:<port>` (plus a bearer token
 * when one is configured).
 *
 * This module is the TRANSLATION LAYER. It defines the wire types and the
 * pure mappers from Talon's internal shapes (`HistoryMessage`, sessions,
 * `AgentEvent`) into them. Nothing Talon-internal crosses the wire — clients
 * depend only on the types here, never on Talon's engine. Bump
 * `BRIDGE_PROTOCOL_VERSION` on a breaking change so clients can refuse a
 * mismatch instead of misrendering.
 */

import type { HistoryMessage } from "../../storage/history.js";

/** Wire-format version. Surfaced in `/health` and the `hello` event. */
export const BRIDGE_PROTOCOL_VERSION = 1;

/** History sender id reserved for Talon's own (assistant) messages. */
export const BOT_SENDER_ID = 0;
/** History sender id used for the human on the other end of a native chat. */
export const USER_SENDER_ID = 1;

export type ClientRole = "user" | "assistant" | "system";

/** An inline button. `url` opens a link; `data` is an opaque callback token. */
export type ClientButton = { text: string; url?: string; data?: string };

/**
 * A tool invocation that ran during an assistant turn, persisted so history
 * shows what the model did even after a reload/restart (additive in v1 —
 * older clients simply ignore the field).
 */
export type ClientToolCall = {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  error?: string;
  /** Wall-clock duration of this call, when known. */
  durationMs?: number;
};

/** A single rendered message in a conversation. */
export type ClientMessage = {
  id: string;
  chatId: string;
  role: ClientRole;
  text: string;
  /** Epoch milliseconds. */
  ts: number;
  buttons?: ClientButton[][];
  reactions?: string[];
  /**
   * Relative bridge path to an attached image (e.g. `/media?id=…`). The
   * client resolves it against its own base URL + token and renders it inline.
   * Present on photo messages the bot sends; `text` carries any caption.
   */
  imagePath?: string;
  /** Tools that ran during this assistant turn (history hydration). */
  tools?: ClientToolCall[];
  /** Turn stats attached once the turn ended (history hydration). */
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
};

/** One full-text search hit: the message plus the chat it lives in. */
export type SearchResult = {
  chatId: string;
  chatTitle: string;
  message: ClientMessage;
};

/** A conversation in the sidebar. */
export type ClientChat = {
  id: string;
  title: string;
  createdAt: number;
  lastActive: number;
  /** Truncated last-message text for the list preview. */
  preview: string;
  /** Resolved model id for this chat, when known. */
  model?: string;
  /** Active backend id for this chat (e.g. "claude", "codex"), when known. */
  backend?: string;
  /** Reasoning effort for this chat, when known. */
  effort?: string;
  /** Whether proactive pulse check-ins are enabled for this chat. */
  pulse?: boolean;
};

/** Daemon-level status shown in the client's header / status pill. */
export type BridgeStatus = {
  app: "talon-bridge";
  protocol: number;
  botName: string;
  backend: string;
  /** Display name of the global default model. */
  model: string;
  activeChats: number;
  startedAt: string;
};

/** A selectable model for the picker. */
export type ModelOption = {
  id: string;
  displayName: string;
  provider: string;
  reasoning: boolean;
};

/** A selectable backend for the picker (e.g. Claude SDK, Codex). */
export type BackendOption = {
  id: string;
  label: string;
};

/**
 * Server → client events, delivered as SSE `data:` lines (one JSON object
 * each). The client switches on `kind`. Streaming text arrives as ephemeral
 * `delta` events; the canonical, persisted reply always arrives as a
 * `message` event (possibly several per turn).
 */
export type BridgeEvent =
  | { kind: "hello"; status: BridgeStatus; chats: ClientChat[] }
  | { kind: "status"; status: BridgeStatus }
  | { kind: "chat_created"; chat: ClientChat }
  | { kind: "chat_updated"; chat: ClientChat }
  | { kind: "chat_deleted"; chatId: string }
  | { kind: "message"; chatId: string; message: ClientMessage }
  | { kind: "message_edited"; chatId: string; messageId: string; text: string }
  | { kind: "message_deleted"; chatId: string; messageId: string }
  | { kind: "reaction"; chatId: string; messageId: string; emoji: string }
  | { kind: "turn_start"; chatId: string }
  | { kind: "reasoning"; chatId: string; text: string }
  | { kind: "delta"; chatId: string; text: string }
  | {
      kind: "tool";
      chatId: string;
      id: string;
      name: string;
      phase: "call" | "result";
      input?: Record<string, unknown>;
      error?: string;
    }
  | { kind: "typing"; chatId: string; on: boolean }
  | {
      kind: "turn_end";
      chatId: string;
      delivered: number;
      durationMs?: number;
      usage?: { input: number; output: number };
    }
  | { kind: "error"; chatId?: string; message: string };

// ── Mappers (Talon internals → wire types) ───────────────────────────────────

/** Collapse whitespace and clip a string for list previews. */
export function previewOf(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Map a persisted history row to a wire message. */
export function historyToClientMessage(
  m: HistoryMessage,
  chatId: string,
): ClientMessage {
  return {
    id: String(m.msgId),
    chatId,
    role: m.senderId === BOT_SENDER_ID ? "assistant" : "user",
    text: m.text,
    ts: m.timestamp,
  };
}
