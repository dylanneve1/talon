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
import { log } from "../../util/log.js";
import { execute } from "../../core/engine/dispatcher.js";
import { toolInputToRecord } from "../../core/agent-runtime/events.js";
import { pushMessage, getRecentHistory } from "../../storage/history.js";
import {
  getChatSettings,
  setChatEffort,
  setChatModelForBackend,
  getChatModelForBackend,
  setChatPulse,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import { resetSession } from "../../storage/sessions.js";
import { configSnapshot, applyConfigUpdate } from "./settings.js";
import { getModels, resolveModel } from "../../core/models/catalog.js";
import {
  getBackendForChat,
  getBackendIdForChat,
} from "../../core/engine/backend-controller/index.js";
import { getActiveReasoningLevels } from "../shared/reasoning-levels.js";
import { NativeChats, type ChatEntry } from "./chats.js";
import { BridgeServer, type BridgeServerHandlers } from "./server.js";
import { createNativeActionHandler } from "./actions.js";
import {
  BRIDGE_PROTOCOL_VERSION,
  BOT_SENDER_ID,
  USER_SENDER_ID,
  historyToClientMessage,
  type BridgeEvent,
  type BridgeStatus,
  type ClientButton,
  type ClientChat,
  type ClientMessage,
  type ModelOption,
} from "./protocol.js";

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

  // Monotonic message-id minter. Seeded from the wall clock so ids stay
  // unique and ascending across restarts (history rows persist their ids).
  let seq = Date.now();
  const nextId = (): number => ++seq;

  // ── Per-chat wire projection ─────────────────────────────────────────────

  function toClientChat(entry: ChatEntry): ClientChat {
    const settings = getChatSettings(entry.id);
    let model: string | undefined;
    try {
      const backendId = getBackendIdForChat(entry.id);
      model = getChatModelForBackend(entry.id, backendId);
    } catch {
      /* backend pool not ready (early boot) — omit model */
    }
    return {
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      lastActive: entry.lastActive,
      preview: entry.preview,
      model,
      effort: settings.effort,
      pulse: settings.pulse,
    };
  }

  const broadcast = (event: BridgeEvent): void => server.broadcast(event);

  const broadcastChatUpdated = (entry: ChatEntry): void =>
    broadcast({ kind: "chat_updated", chat: toClientChat(entry) });

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
    broadcast({ kind: "message", chatId: entry.id, message });
    broadcastChatUpdated(entry);
    return id;
  }

  function emitUser(entry: ChatEntry, text: string): void {
    const id = nextId();
    const ts = Date.now();
    const message: ClientMessage = {
      id: String(id),
      chatId: entry.id,
      role: "user",
      text,
      ts,
    };
    pushMessage(entry.id, {
      msgId: id,
      senderId: USER_SENDER_ID,
      senderName: "User",
      text,
      timestamp: ts,
    });
    chats.touch(entry.id, text);
    broadcast({ kind: "message", chatId: entry.id, message });
    broadcastChatUpdated(entry);
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

  async function runTurn(entry: ChatEntry, text: string): Promise<void> {
    const start = Date.now();
    try {
      const result = await execute({
        chatId: entry.id,
        numericChatId: entry.numericId,
        prompt: text,
        senderName: "User",
        isGroup: false,
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
            case "tool_call":
              broadcast({
                kind: "tool",
                chatId: entry.id,
                id: event.id,
                name: event.name,
                phase: "call",
                input: toolInputToRecord(event.name, event.input),
              });
              break;
            case "tool_result":
              broadcast({
                kind: "tool",
                chatId: entry.id,
                id: event.id,
                name: event.name,
                phase: "result",
                ...(event.error ? { error: event.error } : {}),
              });
              break;
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

      broadcast({ kind: "typing", chatId: entry.id, on: false });
      broadcast({
        kind: "turn_end",
        chatId: entry.id,
        delivered,
        durationMs: result.durationMs,
        usage: { input: result.inputTokens, output: result.outputTokens },
      });
    } catch (err) {
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
    }
  }

  // ── Status + model helpers ───────────────────────────────────────────────

  function status(): BridgeStatus {
    return {
      app: "talon-bridge",
      protocol: BRIDGE_PROTOCOL_VERSION,
      botName,
      backend: config.backend,
      model: resolveModel(config.model)?.displayName ?? config.model,
      activeChats: chats.count(),
      startedAt,
    };
  }

  function listModels(): { active: string; models: ModelOption[] } {
    const models: ModelOption[] = getModels().map((m) => ({
      id: m.id,
      displayName: m.displayName,
      provider: m.provider,
      reasoning: Boolean(m.supportedReasoningLevels?.length),
    }));
    return { active: config.model, models };
  }

  function setModel(chatId: string, model: string): void {
    const entry = chats.get(chatId);
    if (!entry) return;
    const backendId = getBackendIdForChat(chatId);
    setChatModelForBackend(chatId, backendId, model.trim() || undefined);
    broadcastChatUpdated(entry);
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
      if (ok) broadcast({ kind: "chat_deleted", chatId: id });
      return ok;
    },
    history: (id) =>
      getRecentHistory(id, 200)
        .map((m) => historyToClientMessage(m, id))
        .sort((a, b) => Number(a.id) - Number(b.id)),
    send: (id, text) => {
      const entry = chats.get(id) ?? chats.ensure(id);
      emitUser(entry, text);
      broadcast({ kind: "turn_start", chatId: entry.id });
      broadcast({ kind: "typing", chatId: entry.id, on: true });
      void runTurn(entry, text);
    },
    listModels,
    setModel,
    setEffort,
    effortLevels,
    resetChat: (id) => {
      const entry = chats.get(id);
      if (!entry) return false;
      resetSession(id);
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
  };

  const nativeCfg = config.native ?? { port: 19880, host: "127.0.0.1" };
  const server = new BridgeServer(
    {
      host: nativeCfg.host ?? "127.0.0.1",
      port: nativeCfg.port ?? 19880,
      token: nativeCfg.token,
      startedAt,
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
      gateway.registerFrontendHandler(
        "native",
        createNativeActionHandler({
          chats,
          gateway,
          emitAssistant,
          broadcast,
        }),
      );
      const gatewayPort = await gateway.start(19876);
      log("native", `Gateway on :${gatewayPort}`);
      chats.restore();
      await server.start();
    },

    async start() {
      log(
        "native",
        `Native bridge ready (${chats.count()} chat(s)) — connect a client to :${server.getPort()}`,
      );
    },

    async stop() {
      await server.stop();
      await gateway.stop();
    },
  };
}
