/**
 * Native frontend factory.
 *
 * A client-agnostic bridge: it runs the same gateway every messaging frontend
 * uses (so the agent's tools work) PLUS a Bridge server (server.ts) that GUI
 * clients connect to over the v1 protocol. The Electron-replacement Flutter
 * companion app is the reference client, but anything speaking the protocol —
 * a remote Android app over a token-authed LAN connection, a web client —
 * works identically.
 *
 * Per turn it drives `dispatcher.execute()` and forwards the canonical
 * `AgentEvent` stream to clients as Bridge events: reasoning + tool activity
 * stream live, while the persisted reply arrives via the gateway action
 * handler (tool-only backends) or the trailing-prose fallback (text-mode
 * backends) — mirroring the terminal renderer's delivery semantics.
 */

import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import type { Gateway } from "../../core/engine/gateway.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { log, logError } from "../../util/log.js";
import { dirs, files } from "../../util/paths.js";
import { PKG_ROOT } from "../../cli/context.js";
import { getSessionInfo } from "../../storage/sessions.js";
import { buildContextDisplay } from "../shared/status-context.js";
import { resolveActiveModelForChat } from "../../core/models/active-model.js";
import { forceDream } from "../../core/background/dream.js";
import { execute } from "../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../core/agent-runtime/events.js";
import { isDeliveryTool } from "../../core/tools/index.js";
import {
  pushMessage,
  getRecentHistory,
  getHistoryBefore,
  searchHistoryMessages,
  clearHistory,
} from "../../storage/history.js";
import { recordTurnMeta, getTurnMeta, clearTurnMeta } from "./turn-meta.js";
import {
  getChatSettings,
  setChatEffort,
  setChatModelForBackend,
  getChatModelForBackend,
  setChatBackend,
  setChatPulse,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import { resetSession } from "../../storage/sessions.js";
import { resetPulseCheckpoint } from "../../core/background/pulse.js";
import { configSnapshot, applyConfigUpdate } from "./settings.js";
import {
  pluginItems,
  skillItems,
  togglePlugin,
  toggleSkill,
} from "./extensions.js";
import { resolveModel } from "../../core/models/catalog.js";
import {
  getBackendForChat,
  getBackendIdForChat,
  getPooledBackend,
  acquireBackendInstance,
  listAvailableBackends,
  rebindChat,
} from "../../core/engine/backend-controller/index.js";
import { getActiveReasoningLevels } from "../shared/reasoning-levels.js";
import { NativeChats, DEFAULT_CHAT_TITLE, type ChatEntry } from "./chats.js";
import { extractSessionName } from "../../util/session-name.js";
import { BridgeServer, type BridgeServerHandlers } from "./server.js";
import { createNativeActionHandler } from "./actions.js";
import { getMeshService } from "../../core/mesh/index.js";
import { removeBridgeDiscovery, writeBridgeDiscovery } from "./discovery.js";
import { isLoopbackHost, loadOrCreateBridgeTlsIdentity } from "./tls.js";
import { loadOrCreateBridgeToken } from "./auth.js";
import { readLogEntries } from "./logs.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  BOT_SENDER_ID,
  USER_SENDER_ID,
  historyToClientMessage,
  type BackendOption,
  type BridgeEvent,
  type BridgeStatus,
  type ClientButton,
  type ClientChat,
  type ClientMessage,
  type ClientToolCall,
  type ContextInfo,
  type ModelOption,
  type QueuedMessage,
  type SearchResult,
} from "./protocol.js";

/** Best-effort JSON stringify that never throws (circular refs → String()). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Reduce a tool's raw result to a readable, bounded string for the app's
 * expanded tool view. MCP results are typically
 * `{ content: [{ type: "text", text }] }`, so pull the text parts out; fall
 * back to pretty JSON for anything else. Truncated so a huge file read or
 * search dump can't bloat the wire payload or the history sidecar.
 */
export function summarizeToolResult(result: unknown): string | undefined {
  if (result == null) return undefined;
  let text: string;
  if (typeof result === "string") {
    text = result;
  } else {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts = content
        .map((c) =>
          c &&
          typeof c === "object" &&
          typeof (c as { text?: unknown }).text === "string"
            ? (c as { text: string }).text
            : "",
        )
        .filter((s) => s.length > 0);
      text = parts.length > 0 ? parts.join("\n") : safeJson(result);
    } else {
      text = safeJson(result);
    }
  }
  text = text.trim();
  if (!text) return undefined;
  const MAX = 4000;
  return text.length > MAX ? `${text.slice(0, MAX)}\n… (truncated)` : text;
}

export type NativeFrontend = {
  name: "native";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createNativeFrontend(
  config: TalonConfig,
  gateway: Gateway,
): NativeFrontend {
  const startedAt = new Date().toISOString();
  const botName = config.botDisplayName || "Talon";
  const chats = new NativeChats();
  // Daemon-wide mesh service (core/mesh). This frontend is its transport:
  // companions register/report/answer through the bridge routes below, and
  // the SSE transport (wired in init) pushes locate requests and device
  // commands out. The model's mesh tools are served by the shared gateway
  // actions, so they work from every frontend.
  const mesh = getMeshService();
  let unregisterMeshTransport: (() => void) | null = null;

  // Monotonic message-id minter. Seeded from the wall clock so ids stay
  // unique and ascending across restarts (history rows persist their ids).
  let seq = Date.now();
  const nextId = (): number => ++seq;

  // Ephemeral registry mapping a short media id → absolute file path, so the
  // bridge can serve images the bot attaches without exposing raw paths in the
  // URL. Lives for the process; history rows keep only a text placeholder, so
  // images render live in-session (mirroring how the chat frontends behave).
  const media = new Map<string, string>();
  const registerMedia = (filePath: string): string => {
    const id = `m${nextId().toString(36)}`;
    media.set(id, filePath);
    return id;
  };

  // Persist an uploaded attachment to the workspace uploads dir under a safe,
  // unique name, and return its absolute path (handed to the model to read).
  const saveUpload = async (
    filename: string,
    bytes: Buffer,
  ): Promise<string> => {
    await mkdir(dirs.uploads, { recursive: true });
    const safe = basename(filename).replace(/[^\w.-]+/g, "_") || "upload";
    const dest = join(
      dirs.uploads,
      `${Date.now()}-${nextId().toString(36)}-${safe}`,
    );
    await writeFile(dest, bytes);
    return dest;
  };

  // Live context-window fill per chat, refreshed at the end of each turn.
  // Cached (not computed inline) so the sync `toClientChat` projection stays
  // sync — it just reads the last computed value.
  const contextByChat = new Map<string, ContextInfo>();

  // In-progress turns, keyed by chat id, so a client that (re)connects mid-turn
  // can be replayed the turn's tool activity instead of waiting for the turn to
  // finish. Holds the same live tool map `runTurn` mutates; cleared at turn end.
  type LiveToolEntry = {
    call: ClientToolCall;
    startedAt: number;
    done?: boolean;
  };
  const liveTurns = new Map<string, Map<string, LiveToolEntry>>();

  /** True when a turn is currently running for a chat (used to decide queue). */
  const isBusy = (chatId: string): boolean => liveTurns.has(chatId);

  // The single queued follow-up per chat, held server-side so every connected
  // client shares (and can edit/cancel) the same queue. Keeps the attachment
  // paths so a queued image sends intact when the turn ends.
  type QueuedEntry = {
    text: string;
    imagePath?: string;
    attachmentPath?: string;
  };
  const queuedByChat = new Map<string, QueuedEntry>();

  /** Project the stored queue entry to its wire shape (text + attachment flag). */
  function toQueued(chatId: string): QueuedMessage | undefined {
    const q = queuedByChat.get(chatId);
    if (!q) return undefined;
    return { text: q.text, hasAttachment: Boolean(q.attachmentPath) };
  }

  /**
   * Set (or replace) a chat's queued follow-up and sync it to every client via
   * chat_updated. Empty text with no attachment clears the queue.
   */
  function setQueued(chatId: string, next: QueuedEntry): void {
    const entry = chats.get(chatId);
    if (!entry) return;
    const text = next.text.trim();
    if (!text && !next.attachmentPath) {
      if (!queuedByChat.delete(chatId)) return;
    } else {
      queuedByChat.set(chatId, {
        text,
        imagePath: next.imagePath,
        attachmentPath: next.attachmentPath,
      });
    }
    broadcastChatUpdated(entry);
  }

  /**
   * Events that reconstruct every in-progress turn for a freshly-connected
   * client: a turn_start (so the live turn renders), a typing indicator, and
   * each tool's call — plus its result when it has already finished. Replayed
   * right after `hello` so a reconnect mid-turn shows the full tool timeline
   * immediately rather than only the tools that happen to fire afterwards.
   */
  function liveTurnEvents(): BridgeEvent[] {
    const events: BridgeEvent[] = [];
    for (const [chatId, tools] of liveTurns) {
      events.push({ kind: "turn_start", chatId });
      events.push({ kind: "typing", chatId, on: true });
      for (const { call, done } of tools.values()) {
        events.push({
          kind: "tool",
          chatId,
          id: call.id,
          name: call.name,
          phase: "call",
          ...(call.input ? { input: call.input } : {}),
        });
        if (done) {
          events.push({
            kind: "tool",
            chatId,
            id: call.id,
            name: call.name,
            phase: "result",
            ...(call.error ? { error: call.error } : {}),
            ...(call.output ? { output: call.output } : {}),
          });
        }
      }
    }
    return events;
  }

  // ── Per-chat wire projection ─────────────────────────────────────────────

  function toClientChat(entry: ChatEntry): ClientChat {
    const settings = getChatSettings(entry.id);
    let model: string | undefined;
    let backend: string | undefined;
    try {
      // The persisted per-chat setting is the source of truth for what the
      // user picked; the in-memory binding can lag it (boot-time rebind
      // still pending or transiently failed). Reporting the binding here
      // made clients show a chat "reset" to the default backend after a
      // daemon restart even though the user's choice was intact.
      backend = settings.backend ?? getBackendIdForChat(entry.id);
      model = getChatModelForBackend(entry.id, backend);
    } catch {
      backend = settings.backend;
      /* backend pool not ready (early boot) — omit model */
    }
    return {
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      lastActive: entry.lastActive,
      preview: entry.preview,
      model,
      backend,
      effort: settings.effort,
      pulse: settings.pulse,
      context: contextByChat.get(entry.id),
      queued: toQueued(entry.id),
    };
  }

  /**
   * Compute the current context-window fill for a chat from its session
   * usage, reusing the same `buildContextDisplay` the terminal/Discord
   * `/status` line uses. When the session's usage doesn't carry a window
   * size yet (fresh session), fall back to the resolved model's window so
   * the readout still lands. Returns undefined when nothing is known — the
   * clients hide the indicator rather than render a bogus 0%.
   */
  async function computeContext(
    chatId: string,
    opts?: { resolveModel?: boolean },
  ): Promise<ContextInfo | undefined> {
    try {
      const info = getSessionInfo(chatId);
      const u = info.usage;
      let ctxMax = u.contextWindow;
      // The model fallback touches the backend pool, which is fine for one
      // chat the user just opened and wrong for every chat at boot — the
      // startup warm asks for the cheap path and lets anything it can't
      // resolve fill in when that chat is next opened.
      if (!ctxMax && opts?.resolveModel !== false) {
        try {
          const backend = getBackendForChat(chatId);
          const backendId = getBackendIdForChat(chatId);
          const { ref } = await resolveActiveModelForChat(
            chatId,
            backend,
            backendId,
            config,
          );
          if (ref?.contextWindow) ctxMax = ref.contextWindow;
        } catch {
          /* backend pool not ready — leave max unknown */
        }
      }
      const ctx = buildContextDisplay({
        contextTokens: u.contextTokens,
        lastPromptTokens: u.lastPromptTokens,
        contextWindow: ctxMax,
      });
      if (!ctx.known && ctx.max === 0) return undefined;
      return {
        known: ctx.known,
        used: ctx.used,
        max: ctx.max,
        pct: ctx.pct,
        warn: ctx.warn,
      };
    } catch {
      return undefined;
    }
  }

  /** Recompute a chat's context fill and, if it changed, push it to clients. */
  async function refreshContext(
    entry: ChatEntry,
    opts?: { resolveModel?: boolean },
  ): Promise<void> {
    const next = await computeContext(entry.id, opts);
    if (!next) return;
    const prev = contextByChat.get(entry.id);
    if (prev && prev.used === next.used && prev.max === next.max) return;
    contextByChat.set(entry.id, next);
    broadcastChatUpdated(entry);
  }

  /**
   * Fill the context cache for chats restored at startup.
   *
   * The readout is served from an in-memory map that was only ever written at
   * turn end, so after a restart every existing chat reported no context at
   * all — the header chip vanished until that chat ran another turn, which
   * read as "context usage doesn't save". The numbers themselves are
   * persisted with the session; only the cache was cold. This re-reads them
   * for the most recently active chats (bounded, and on the cheap path that
   * never touches the backend pool); anything it skips or can't resolve is
   * filled in the moment the chat is opened.
   */
  const CONTEXT_WARM_LIMIT = 40;

  async function warmContextCache(): Promise<void> {
    for (const entry of chats.list().slice(0, CONTEXT_WARM_LIMIT)) {
      await refreshContext(entry, { resolveModel: false });
    }
  }

  const broadcast = (event: BridgeEvent): void => server.broadcast(event);

  // The most recent assistant message id per chat — turn_end attaches the
  // turn's meta (tools/stats) to this message so history hydration can show
  // what the model did after a reload.
  const lastAssistantId = new Map<string, string>();

  const broadcastChatUpdated = (entry: ChatEntry): void =>
    broadcast({ kind: "chat_updated", chat: toClientChat(entry) });

  /**
   * Name a chat from its first user message — instantly and for free.
   *
   * The title is a trimmed slice of the first message (no model call), so it
   * lands the moment the user hits send instead of staying "New chat" until
   * the turn finishes and a restart re-hydrates the persisted name. Only fires
   * while the chat still carries the placeholder title, so a user's manual
   * rename is never clobbered. Callers broadcast `chat_updated` afterwards, so
   * the change propagates to every connected client live.
   */
  function maybeAutoTitle(entry: ChatEntry, text: string): void {
    if (entry.title && entry.title !== DEFAULT_CHAT_TITLE) return;
    const title = extractSessionName(text);
    if (title) chats.rename(entry.id, title);
  }

  // ── Outbound message helpers (persist + broadcast) ───────────────────────

  function emitAssistant(
    entry: ChatEntry,
    text: string,
    buttons?: ClientButton[][],
  ): number {
    const id = nextId();
    const ts = Date.now();
    const message: ClientMessage = {
      id: String(id),
      chatId: entry.id,
      role: "assistant",
      text,
      ts,
      ...(buttons ? { buttons } : {}),
    };
    pushMessage(entry.id, {
      msgId: id,
      senderId: BOT_SENDER_ID,
      senderName: botName,
      text,
      timestamp: ts,
    });
    chats.touch(entry.id, text);
    lastAssistantId.set(entry.id, String(id));
    broadcast({ kind: "message", chatId: entry.id, message });
    broadcastChatUpdated(entry);
    return id;
  }

  /** Persist + broadcast an assistant photo message (image + optional caption). */
  function emitPhoto(
    entry: ChatEntry,
    filePath: string,
    caption?: string,
  ): number {
    const id = nextId();
    const ts = Date.now();
    const text = caption?.trim() ?? "";
    const mediaId = registerMedia(filePath);
    const message: ClientMessage = {
      id: String(id),
      chatId: entry.id,
      role: "assistant",
      text,
      ts,
      imagePath: `/media?id=${encodeURIComponent(mediaId)}`,
    };
    // Persist the image reference so it re-renders when history reloads (the
    // filePath is re-registered into the media map on read). The caption is
    // stored as plain text; the `photo` mediaType carries the image marker.
    pushMessage(entry.id, {
      msgId: id,
      senderId: BOT_SENDER_ID,
      senderName: botName,
      text,
      timestamp: ts,
      mediaType: "photo",
      filePath,
    });
    chats.touch(entry.id, text || "[photo]");
    lastAssistantId.set(entry.id, String(id));
    broadcast({ kind: "message", chatId: entry.id, message });
    broadcastChatUpdated(entry);
    return id;
  }

  /** Persist + broadcast a user message; returns its numeric id so the turn
   *  hands the model that same id (as `[msg_id:N]`) to react/reply to.
   *  An optional imagePath renders an attached image inline. */
  function emitUser(
    entry: ChatEntry,
    text: string,
    imagePath?: string,
    attachmentPath?: string,
  ): number {
    const id = nextId();
    const ts = Date.now();
    const message: ClientMessage = {
      id: String(id),
      chatId: entry.id,
      role: "user",
      text,
      ts,
      ...(imagePath ? { imagePath } : {}),
    };
    // For an attached image, persist the on-disk path + a `photo` mediaType so
    // it re-renders on history reload (rehydrated in the `history` handler)
    // instead of vanishing to a text-only placeholder. Caption stays as text.
    pushMessage(entry.id, {
      msgId: id,
      senderId: USER_SENDER_ID,
      senderName: "User",
      text,
      timestamp: ts,
      ...(imagePath
        ? {
            mediaType: "photo" as const,
            ...(attachmentPath ? { filePath: attachmentPath } : {}),
          }
        : {}),
    });
    chats.touch(entry.id, imagePath ? text || "[photo]" : text);
    maybeAutoTitle(entry, text);
    broadcast({ kind: "message", chatId: entry.id, message });
    broadcastChatUpdated(entry);
    return id;
  }

  /** Transient, non-persisted notice (e.g. "session reset"). */
  function emitSystem(entry: ChatEntry, text: string): void {
    broadcast({
      kind: "message",
      chatId: entry.id,
      message: {
        id: `sys-${nextId()}`,
        chatId: entry.id,
        role: "system",
        text,
        ts: Date.now(),
      },
    });
  }

  // ── A user turn ──────────────────────────────────────────────────────────

  async function runTurn(
    entry: ChatEntry,
    text: string,
    messageId: number,
    attachmentPath?: string,
  ): Promise<void> {
    const start = Date.now();
    // Tool calls observed during this turn, in call order — recorded into the
    // turn-meta sidecar at turn_end so history can replay the timeline. Also
    // registered in `liveTurns` so a client connecting mid-turn can be replayed
    // the activity so far (cleared in the `finally`).
    const turnTools = new Map<string, LiveToolEntry>();
    liveTurns.set(entry.id, turnTools);
    // Safety net: any tool the backend announced but never resolved
    // (a crash can eat a tool_result; callback backends historically
    // never emitted one — handler-to-events now pairs each tool_call
    // with an immediate synthetic result) gets a synthetic result at
    // turn end — a spinner the app opened on phase:"call" must always
    // see a phase:"result".
    const flushOpenTools = () => {
      for (const [id, live] of turnTools) {
        if (live.done) continue;
        live.done = true;
        live.call.durationMs = Date.now() - live.startedAt;
        broadcast({
          kind: "tool",
          chatId: entry.id,
          id,
          name: live.call.name,
          phase: "result",
        });
      }
    };
    // Point the model at an attached image so it can read the file itself.
    const prompt = attachmentPath
      ? `${text ? `${text}\n\n` : ""}[Attached image: ${attachmentPath}]`
      : text;
    try {
      const result = await execute({
        chatId: entry.id,
        numericChatId: entry.numericId,
        prompt,
        senderName: "User",
        isGroup: false,
        // Give the model the user message's id so `[msg_id:N]` is present and
        // react/reply/edit target the user's message — not the bot's.
        messageId,
        source: "message",
        onEvent: async (event) => {
          switch (event.type) {
            case "reasoning":
              if (event.text)
                broadcast({
                  kind: "reasoning",
                  chatId: entry.id,
                  text: event.text,
                });
              break;
            case "text_delta":
              broadcast({ kind: "delta", chatId: entry.id, text: event.text });
              break;
            case "tool_call": {
              // Delivery plumbing (end_turn / send_message / react) never
              // enters the tool timeline — its effect arrives as the
              // `message`/reaction itself. Skipping here keeps the live
              // stream, the mid-turn replay to late joiners, and the
              // persisted turn meta consistent from one choke point.
              if (isDeliveryTool(event.name)) break;
              const input = toolInputToRecord(event.name, event.input);
              turnTools.set(event.id, {
                call: { id: event.id, name: event.name, input },
                startedAt: Date.now(),
              });
              broadcast({
                kind: "tool",
                chatId: entry.id,
                id: event.id,
                name: event.name,
                phase: "call",
                input,
              });
              break;
            }
            case "tool_result": {
              if (isDeliveryTool(event.name)) break;
              const output = summarizeToolResult(event.result);
              const live = turnTools.get(event.id);
              if (live) {
                live.done = true;
                live.call.durationMs = Date.now() - live.startedAt;
                if (event.error) live.call.error = event.error;
                if (output) live.call.output = output;
              }
              broadcast({
                kind: "tool",
                chatId: entry.id,
                id: event.id,
                name: event.name,
                phase: "result",
                ...(event.error ? { error: event.error } : {}),
                ...(output ? { output } : {}),
              });
              break;
            }
            case "error":
              broadcast({
                kind: "error",
                chatId: entry.id,
                message: event.error.message,
              });
              break;
          }
        },
      });

      // Trailing-prose fallback: text-mode backends (kilo/opencode/codex)
      // deliver the reply as plain text rather than a bridge send. When no
      // delivery tool fired this turn, surface result.text as the message —
      // exactly what the terminal renderer does.
      let delivered = result.bridgeMessageCount;
      if (delivered === 0 && result.text.trim()) {
        emitAssistant(entry, result.text.trim());
        delivered = 1;
      }

      // Resolve open tool spinners BEFORE persisting turn meta, so the
      // synthetic durations land in the recorded timeline too.
      flushOpenTools();

      // Persist what this turn did against its final assistant message, so
      // reloaded history keeps the tool timeline + stats footer. Only when
      // the turn actually delivered — otherwise the "last assistant id"
      // belongs to a previous turn and the meta would land on the wrong row.
      if (delivered > 0) {
        const msgId = lastAssistantId.get(entry.id);
        if (msgId) {
          const tools = [...turnTools.values()].map((t) => t.call);
          recordTurnMeta(entry.id, msgId, {
            durationMs: result.durationMs,
            tokensIn: result.inputTokens,
            tokensOut: result.outputTokens,
            ...(tools.length ? { tools } : {}),
          });
        }
      }

      broadcast({ kind: "typing", chatId: entry.id, on: false });
      broadcast({
        kind: "turn_end",
        chatId: entry.id,
        delivered,
        durationMs: result.durationMs,
        usage: { input: result.inputTokens, output: result.outputTokens },
      });

      // Refresh the live context-window readout now the turn's usage has
      // settled, and push it to clients via chat_updated. Best-effort — a
      // failure here must never surface as a turn error.
      void refreshContext(entry).catch(() => {});
    } catch (err) {
      flushOpenTools();
      broadcast({ kind: "typing", chatId: entry.id, on: false });
      broadcast({
        kind: "error",
        chatId: entry.id,
        message: err instanceof Error ? err.message : String(err),
      });
      broadcast({
        kind: "turn_end",
        chatId: entry.id,
        delivered: 0,
        durationMs: Date.now() - start,
      });
    } finally {
      // The turn is over (delivered or errored) — stop replaying it to new
      // clients. Any late tool spinner has already been flushed above.
      liveTurns.delete(entry.id);
      // Flush a queued follow-up as a fresh turn: "once it's done it will
      // send". Deferred so we don't re-enter runTurn inside its own finally.
      const queued = queuedByChat.get(entry.id);
      if (queued) {
        queuedByChat.delete(entry.id);
        broadcastChatUpdated(entry);
        setImmediate(() =>
          startTurn(entry, queued.text, {
            imagePath: queued.imagePath,
            attachmentPath: queued.attachmentPath,
          }),
        );
      }
    }
  }

  /** Emit the user message, open the turn, and drive it. Shared by the /send
   *  handler and the queued-follow-up flush. */
  function startTurn(
    entry: ChatEntry,
    text: string,
    opts?: { imagePath?: string; attachmentPath?: string },
  ): void {
    const messageId = emitUser(
      entry,
      text,
      opts?.imagePath,
      opts?.attachmentPath,
    );
    broadcast({ kind: "turn_start", chatId: entry.id });
    broadcast({ kind: "typing", chatId: entry.id, on: true });
    void runTurn(entry, text, messageId, opts?.attachmentPath);
  }

  // ── Status + model helpers ───────────────────────────────────────────────

  function status(): BridgeStatus {
    return {
      app: "talon-bridge",
      protocol: BRIDGE_PROTOCOL_VERSION,
      capabilities: ["mesh", "mesh-commands", "plugins-skills"],
      botName,
      backend: config.backend,
      model: resolveModel(config.model)?.displayName ?? config.model,
      activeChats: chats.count(),
      startedAt,
    };
  }

  async function listModels(chatId?: string): Promise<{
    active: string;
    models: ModelOption[];
  }> {
    // Resolve the chat's *own* backend so the model list tracks whatever
    // backend the chat is currently bound to (fixes the list staying on the
    // previous backend's models after a switch). Fall back to the global
    // default backend when there's no chat / the pool isn't ready yet.
    let backendId: string = config.backend;
    let active = config.model;
    if (chatId) {
      try {
        // Persisted setting first — see toClientChat.
        backendId =
          getChatSettings(chatId).backend ?? getBackendIdForChat(chatId);
        active = getChatModelForBackend(chatId, backendId) ?? config.model;
      } catch {
        /* pool not ready — keep global defaults */
      }
    }

    // Pull the models dynamically from the gateway for that backend. Prefer
    // an already-pooled instance of the *resolved* backend (the persisted
    // choice — the chat's live binding can lag it after a failed boot-time
    // rebind, and listing the live binding's catalog here showed the wrong
    // backend's models); otherwise boot the backend transiently to read its
    // catalog, then release it so we never leak an instance — mirroring the
    // shared `list_models` action.
    let instance:
      | Awaited<ReturnType<typeof acquireBackendInstance>>["backend"]
      | null
      | undefined = getPooledBackend(backendId);
    let release: (() => Promise<void>) | null = null;
    if (!instance) {
      try {
        const acquired = await acquireBackendInstance(backendId);
        instance = acquired.backend;
        release = acquired.release;
      } catch {
        return { active, models: [] };
      }
    }

    try {
      const catalog = instance.models;
      if (!catalog?.listModels) return { active, models: [] };
      const { models } = await catalog.listModels("all");
      const options: ModelOption[] = models
        .filter((m) => m.selectable)
        .map((m) => ({
          id: m.id,
          displayName: m.displayName,
          provider: m.provider,
          reasoning:
            Boolean(m.supportedReasoningLevels?.length) || Boolean(m.reasoning),
        }));
      return { active, models: options };
    } catch {
      return { active, models: [] };
    } finally {
      if (release) await release();
    }
  }

  function setModel(chatId: string, model: string): void {
    const entry = chats.get(chatId);
    if (!entry) return;
    // Persisted setting first — see toClientChat. Writing the pick under the
    // live binding's key would attach it to the wrong backend whenever the
    // boot-time rebind to the persisted backend is still pending.
    const backendId =
      getChatSettings(chatId).backend ?? getBackendIdForChat(chatId);
    setChatModelForBackend(chatId, backendId, model.trim() || undefined);
    broadcastChatUpdated(entry);
  }

  function listBackends(chatId: string): {
    active: string;
    backends: BackendOption[];
  } {
    const backends = listAvailableBackends(config);
    let active: string = config.backend;
    try {
      if (chatId) {
        // Persisted setting first — see toClientChat.
        active = getChatSettings(chatId).backend ?? getBackendIdForChat(chatId);
      }
    } catch {
      /* pool not ready — report the global default backend */
    }
    return { active, backends };
  }

  /**
   * Switch a chat to another backend. Mirrors the Telegram `/model` backend
   * submenu: verify the target is enabled, rebind the chat's pool holder, pin
   * the override, and drop the previous backend's per-chat session state
   * (sessions aren't portable across backends). Per-backend model picks are
   * kept, so switching back restores the prior model automatically.
   */
  async function setBackend(
    chatId: string,
    backend: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const entry = chats.get(chatId);
    if (!entry) return { ok: false, error: "No such chat" };
    const target = backend.trim();
    const available = listAvailableBackends(config);
    if (!available.some((b) => b.id === target)) {
      return { ok: false, error: "Backend not available" };
    }
    const persisted = getChatSettings(chatId).backend;
    if (getBackendIdForChat(chatId) === target) {
      // Already live on the target — just make sure the choice is persisted.
      if (persisted !== target && target !== config.backend) {
        setChatBackend(chatId, target);
        broadcastChatUpdated(entry);
      }
      return { ok: true };
    }

    const result = await rebindChat(chatId, target, config);
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Rebind failed" };
    }

    // Re-selecting the backend this chat is already persisted to is a
    // RE-ATTACH (e.g. the boot-time rebind failed transiently and the user —
    // or a client retry — picks it again). The conversation belongs to that
    // backend; resetting the session and wiping history here destroyed real
    // conversations and surfaced as a phantom "backend reset" in clients.
    if (persisted === target) {
      broadcastChatUpdated(entry);
      broadcast({ kind: "status", status: status() });
      return { ok: true };
    }

    setChatBackend(chatId, target);
    resetSession(chatId);
    clearHistory(chatId);
    clearTurnMeta(chatId);
    contextByChat.delete(chatId);
    queuedByChat.delete(chatId);
    resetPulseCheckpoint(chatId);
    emitSystem(entry, `Switched to ${target} — starting a fresh conversation.`);
    broadcastChatUpdated(entry);
    broadcast({ kind: "status", status: status() });
    return { ok: true };
  }

  function setEffort(chatId: string, effort: string): void {
    const entry = chats.get(chatId);
    if (!entry) return;
    const level = EFFORT_LEVELS.includes(effort as EffortLevel)
      ? (effort as EffortLevel)
      : undefined;
    setChatEffort(chatId, level);
    broadcastChatUpdated(entry);
  }

  async function effortLevels(
    chatId: string,
  ): Promise<{ active: string; levels: string[] }> {
    try {
      const backend = getBackendForChat(chatId);
      const backendId = getBackendIdForChat(chatId);
      const { levels } = await getActiveReasoningLevels({
        chatId,
        backend,
        backendId,
        config,
      });
      const active = getChatSettings(chatId).effort ?? "adaptive";
      return { active, levels };
    } catch {
      return { active: "adaptive", levels: [] };
    }
  }

  // ── Daemon control (restart / dream) ─────────────────────────────────────

  /**
   * Restart the daemon by spawning a detached `talon restart` — the same
   * command a human runs. It must be an independent, detached process: the
   * restart stops *this* process, so doing it in-process would kill us before
   * the successor is spawned. The child outlives us, tears the daemon down,
   * and brings a fresh one up. Mirrors `core/daemon/control.ts`'s own
   * source-vs-compiled-binary spawn recipe.
   */
  function spawnDaemonRestart(): void {
    const isBunBinary =
      (process.argv[1] ?? "").includes("~BUN") ||
      (process.argv[1] ?? "").includes("$bunfs");
    const cmd = process.execPath;
    const args = isBunBinary
      ? ["restart"]
      : [
          resolve(PKG_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
          resolve(PKG_ROOT, "src", "cli.ts"),
          "restart",
        ];
    const cwd = isBunBinary ? dirname(process.execPath) : PKG_ROOT;
    const child = spawn(cmd, args, {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
      windowsHide: true,
    });
    child.unref();
  }

  /**
   * Daemon-level control actions the app fires from Settings. Kept minimal and
   * explicit — each maps to a well-understood operation the CLI already
   * exposes, so there's no new privileged surface beyond "what a local admin
   * could already do".
   */
  async function control(
    action: string,
  ): Promise<{ ok: boolean; message: string }> {
    switch (action) {
      case "restart":
        spawnDaemonRestart();
        return {
          ok: true,
          message: "Restarting Talon — back online in a few seconds.",
        };
      case "dream":
        // Fire-and-forget: a dream run can take a while; the app just needs
        // to know it started. forceDream throws if one is already running.
        try {
          void forceDream().catch((err) =>
            logError("native", "Manual dream run failed", err),
          );
          return { ok: true, message: "Dream started — consolidating memory." };
        } catch (err) {
          return {
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      default:
        return { ok: false, message: `Unknown control action: ${action}` };
    }
  }

  // ── Empty-chat sweeper ───────────────────────────────────────────────────
  //
  // "New chat" creates a real chat on the daemon the instant it's tapped, so
  // opening one and backing out of it leaves an empty row in every client's
  // list forever. The app deletes an untouched chat as soon as you leave it,
  // which covers the normal case immediately; this is the backstop for the
  // ones no client got to clean up — the app was killed, the network dropped,
  // or the chat was created by something that never came back.
  //
  // Deliberately conservative: only chats that never carried a single message
  // (see ChatEntry.used, which a reset does NOT clear), only after an hour,
  // never one with a turn running or a message queued, and never one whose
  // history says otherwise. Deleting via the same handler every client uses
  // means the removal is broadcast, so open lists update in place.
  const EMPTY_CHAT_MIN_AGE_MS = 60 * 60_000;
  const EMPTY_CHAT_SWEEP_INTERVAL_MS = 30 * 60_000;
  let emptyChatSweep: ReturnType<typeof setInterval> | null = null;

  function sweepEmptyChats(): void {
    for (const entry of chats.unused(EMPTY_CHAT_MIN_AGE_MS)) {
      if (isBusy(entry.id) || queuedByChat.has(entry.id)) continue;
      if (getRecentHistory(entry.id, 1).length > 0) continue;
      if (handlers.deleteChat(entry.id)) {
        log("native", `Swept empty chat ${entry.id}`);
      }
    }
  }

  // ── Bridge server wiring ─────────────────────────────────────────────────

  const handlers: BridgeServerHandlers = {
    status,
    listChats: () => chats.list().map(toClientChat),
    createChat: (title) => {
      const entry = chats.create(title);
      const chat = toClientChat(entry);
      broadcast({ kind: "chat_created", chat });
      return chat;
    },
    renameChat: (id, title) => {
      const entry = chats.rename(id, title);
      if (!entry) return null;
      const chat = toClientChat(entry);
      broadcast({ kind: "chat_updated", chat });
      return chat;
    },
    deleteChat: (id) => {
      const ok = chats.remove(id);
      if (ok) {
        clearTurnMeta(id);
        contextByChat.delete(id);
        queuedByChat.delete(id);
        broadcast({ kind: "chat_deleted", chatId: id });
      }
      return ok;
    },
    history: (id, opts) => {
      // Opening a chat is the one moment we know a client wants its numbers:
      // refresh the context readout on the full path (model fallback and
      // all), which covers every chat the startup warm skipped or couldn't
      // resolve. Fire-and-forget — the figure arrives as a chat_updated.
      const entry = chats.get(id);
      if (entry && opts?.before === undefined) {
        void refreshContext(entry).catch(() => {});
      }
      const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
      const rows =
        opts?.before !== undefined
          ? getHistoryBefore(id, opts.before, limit)
          : getRecentHistory(id, limit);
      return rows
        .map((m) => {
          const msg = historyToClientMessage(m, id);
          // Re-hydrate an attached image: re-register its on-disk path into
          // the media map and hand back a fresh /media URL so the image shows
          // in reloaded history (survives restarts as long as the file exists).
          if (m.mediaType === "photo" && m.filePath) {
            const mediaId = registerMedia(m.filePath);
            msg.imagePath = `/media?id=${encodeURIComponent(mediaId)}`;
          }
          // Re-hydrate turn meta (tool timeline + stats) for assistant rows.
          if (msg.role === "assistant") {
            const meta = getTurnMeta(id, msg.id);
            if (meta) {
              // Delivery tools are excluded at record time, but metas
              // persisted by older daemons still carry them — filter on
              // the way out so upgraded installs get clean history too.
              const tools = meta.tools?.filter((t) => !isDeliveryTool(t.name));
              if (tools?.length) msg.tools = tools;
              if (meta.durationMs) msg.durationMs = meta.durationMs;
              if (meta.tokensIn) msg.tokensIn = meta.tokensIn;
              if (meta.tokensOut) msg.tokensOut = meta.tokensOut;
            }
          }
          return msg;
        })
        .sort((a, b) => Number(a.id) - Number(b.id));
    },
    search: (query, chatId) => {
      const targets = chatId
        ? [chats.get(chatId)].filter((e): e is ChatEntry => e != null)
        : chats.list();
      const results: SearchResult[] = [];
      for (const entry of targets) {
        for (const m of searchHistoryMessages(entry.id, query, 10)) {
          results.push({
            chatId: entry.id,
            chatTitle: entry.title,
            message: historyToClientMessage(m, entry.id),
          });
        }
      }
      // Newest hits first, bounded across all chats.
      results.sort((a, b) => b.message.ts - a.message.ts);
      return results.slice(0, 50);
    },
    send: (id, text, opts) => {
      const entry = chats.get(id) ?? chats.ensure(id);
      // A turn is already running for this chat — don't interrupt it. Park the
      // message as the single queued follow-up (synced to every client); it
      // auto-sends when the running turn ends. `isBusy` reads `liveTurns`,
      // which `runTurn` sets synchronously, so even a rapid second /send from
      // any client is caught here rather than starting a concurrent turn.
      if (isBusy(entry.id)) {
        setQueued(entry.id, {
          text,
          imagePath: opts?.imagePath,
          attachmentPath: opts?.attachmentPath,
        });
        return;
      }
      startTurn(entry, text, opts);
    },
    queueMessage: (id, text) => {
      // Edit/replace the queued follow-up (text-only). Empty clears it.
      const entry = chats.get(id);
      if (entry) setQueued(entry.id, { text });
    },
    upload: async (filename, _contentType, bytes) => {
      const path = await saveUpload(filename, bytes);
      const mediaId = registerMedia(path);
      return { imagePath: `/media?id=${encodeURIComponent(mediaId)}`, path };
    },
    listModels,
    setModel,
    listBackends,
    setBackend,
    setEffort,
    effortLevels,
    interruptTurn: async (id) => {
      const entry = chats.get(id);
      if (!entry) return false;
      // Only meaningful while a turn is actually running.
      if (!isBusy(id)) return false;
      let backend = null;
      try {
        backend = getBackendForChat(id);
      } catch {
        return false;
      }
      const interrupt = backend?.chat?.interruptChatTurn;
      if (!interrupt) return false;
      try {
        return await interrupt(id);
      } catch {
        return false;
      }
    },
    resetChat: (id) => {
      const entry = chats.get(id);
      if (!entry) return false;
      // Full reset, matching /reset on the other frontends: session,
      // history (the app re-fetches its transcript from us), pulse
      // checkpoint, and any in-process backend memory. Warm the fresh
      // session in the background — the bridge handler is sync.
      resetSession(id);
      clearHistory(id);
      clearTurnMeta(id);
      contextByChat.delete(id);
      queuedByChat.delete(id);
      resetPulseCheckpoint(id);
      let backend = null;
      try {
        backend = getBackendForChat(id);
      } catch {
        // No pool binding — nothing to wipe or warm.
      }
      backend?.sessions?.resetChat?.(id);
      void backend?.sessions?.warmSession?.(id)?.catch(() => {});
      emitSystem(entry, "Session reset — starting a fresh conversation.");
      broadcastChatUpdated(entry);
      return true;
    },
    setPulse: (id, on) => {
      const entry = chats.get(id);
      if (!entry) return;
      setChatPulse(id, on);
      broadcastChatUpdated(entry);
    },
    getConfig: () => configSnapshot(config),
    setConfig: (update) => {
      const snap = applyConfigUpdate(config, update);
      broadcast({ kind: "status", status: status() });
      return snap;
    },
    listPlugins: () => pluginItems(config),
    setPluginEnabled: (name, enabled) =>
      togglePlugin(config, getPooledBackend(config.backend), name, enabled),
    listSkills: () => skillItems(),
    setSkillEnabled: (name, enabled) =>
      toggleSkill(config, getPooledBackend(config.backend), name, enabled),
    control,
    logs: ({ lines, minLevel, component }) =>
      readLogEntries(files.log, { limit: lines, minLevel, component }),
    liveTurnEvents,
    mediaPath: (id) => media.get(id) ?? null,
    // Mesh routes are thin transport shims over the shared core service —
    // storeLocation wakes any pending fresh-fix waiters inside the service.
    registerDevice: (body) => mesh.register(body),
    storeLocation: (body) => mesh.storeLocation(body),
    listDevices: () => mesh.list(),
    completeCommand: (body) => mesh.completeCommand(body),
    acceptFileUpload: (token, body, fromDeviceId) =>
      mesh.acceptFileUpload(token, body, fromDeviceId),
    openFileDownload: (token, fromDeviceId) =>
      mesh.openFileDownload(token, fromDeviceId),
    openNodeInstall: (token) => mesh.openNodeInstall(token),
    openNodeBinary: (token) => mesh.openNodeBinary(token),
  };

  const nativeCfg = config.native ?? { port: 19880, host: "127.0.0.1" };
  const bridgeHost = nativeCfg.host ?? "127.0.0.1";
  // Encrypted by default the moment the bridge leaves the machine; loopback
  // stays plain HTTP unless explicitly opted in (`native.tls`).
  const bridgeTls = nativeCfg.tls ?? !isLoopbackHost(bridgeHost);
  // Never serve the agent API to the network unauthenticated: a non-loopback
  // bind with no configured token gets a persistent auto-minted one instead.
  // `?? ` alone would treat an empty string as a configured token and skip
  // the mint, serving the LAN unauthenticated while looking configured —
  // easy to hit from `"token": "${BRIDGE_TOKEN}"` with the var unset.
  const configuredToken =
    nativeCfg.token !== undefined && nativeCfg.token !== ""
      ? nativeCfg.token
      : undefined;
  const bridgeToken =
    configuredToken ??
    (isLoopbackHost(bridgeHost) ? undefined : loadOrCreateBridgeToken());
  const server = new BridgeServer(
    {
      host: bridgeHost,
      port: nativeCfg.port ?? 19880,
      token: bridgeToken,
      allowedOrigins: nativeCfg.allowedOrigins,
      startedAt,
      ...(bridgeTls ? { tls: () => loadOrCreateBridgeTlsIdentity() } : {}),
    },
    handlers,
  );

  // ── Frontend interface ─────────────────────────────────────────────────--

  const context: ContextManager = {
    acquire: (chatId: number, stringId?: string) =>
      gateway.setContext(chatId, stringId, "native"),
    release: (chatId: number) => gateway.clearContext(chatId),
    getMessageCount: (chatId: number) => gateway.getMessageCount(chatId),
  };

  return {
    name: "native",
    context,

    sendTyping: async (chatId: number) => {
      const entry = chats.byNumeric(chatId);
      if (entry) broadcast({ kind: "typing", chatId: entry.id, on: true });
    },

    // Used by cron / pulse / heartbeat to reach a chat outside a user turn.
    sendMessage: async (chatId: number, text: string) => {
      if (!text.trim()) return;
      const entry = chats.byNumeric(chatId);
      if (entry) emitAssistant(entry, text);
    },

    getBridgePort: () => gateway.getPort(),

    async init() {
      await mesh.load();
      // Plug this bridge in as the mesh's transport: locates and device
      // commands (from ANY frontend's mesh tool calls) leave as SSE events.
      //
      // A locate is a bare "who's there?" — no secret in the frame, and
      // pre-command app builds rely on receiving it — so it still fans out.
      // A command is the opposite: its params carry transfer tokens, exec
      // command lines and (on the chunked fallback) file bodies, so it goes
      // to the target device's own client(s) only.
      unregisterMeshTransport = mesh.registerTransport({
        locate: (deviceId) => broadcast({ kind: "locate", deviceId }),
        command: (command) =>
          server.sendToDevice(command.deviceId, {
            kind: "device_command",
            id: command.id,
            deviceId: command.deviceId,
            name: command.name,
            params: command.params,
          }),
      });
      // Mesh tool actions (list_devices / get_device_location) are shared
      // gateway actions now — no native-only cases here.
      gateway.registerFrontendHandler(
        "native",
        createNativeActionHandler({
          chats,
          gateway,
          emitAssistant,
          emitPhoto,
          broadcast,
        }),
      );
      const gatewayPort = await gateway.start(19876);
      log("native", `Gateway on :${gatewayPort}`);
      chats.restore();
      // Non-blocking: a cold cache costs a missing chip, not a broken boot.
      void warmContextCache().catch((err) =>
        logError("native", "Context cache warm failed", err),
      );
      emptyChatSweep = setInterval(() => {
        try {
          sweepEmptyChats();
        } catch (err) {
          logError("native", "Empty-chat sweep failed", err);
        }
      }, EMPTY_CHAT_SWEEP_INTERVAL_MS);
      // Housekeeping must never be the reason the process stays alive.
      emptyChatSweep.unref?.();
      await server.start();
      const fingerprint = server.getFingerprint();
      // Tell the mesh how this bridge is reachable — everything a generated
      // node installer needs (make_node_install_link fails cleanly without it).
      mesh.setBridgeInfo({
        scheme: server.getScheme(),
        host: bridgeHost,
        port: server.getPort(),
        ...(bridgeToken ? { token: bridgeToken } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      });
      await writeBridgeDiscovery({
        port: server.getPort(),
        token: bridgeToken,
        scheme: server.getScheme(),
        ...(fingerprint ? { fingerprint } : {}),
        startedAt: Date.parse(startedAt),
      });
    },

    async start() {
      log(
        "native",
        `Native bridge ready (${chats.count()} chat(s)) — connect a client to :${server.getPort()}`,
      );
    },

    async stop() {
      if (emptyChatSweep) {
        clearInterval(emptyChatSweep);
        emptyChatSweep = null;
      }
      unregisterMeshTransport?.();
      unregisterMeshTransport = null;
      mesh.setBridgeInfo(null);
      await removeBridgeDiscovery();
      await server.stop();
      await gateway.stop();
    },
  };
}
