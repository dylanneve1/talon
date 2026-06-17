/**
 * Model / backend discovery — `list_models` and `list_backends`.
 *
 * Never boots a backend just to read its catalog: a model list is only
 * available for the chat's own (always-live) backend or another pooled one.
 */

import {
  getBackendForChat,
  getBackendIdForChat,
  getAvailableBackends,
  getPooledBackend,
} from "../backend-controller/index.js";
import type { SharedActionHandlers } from "./types.js";

export const modelHandlers: SharedActionHandlers = {
  list_models: async (body, chatId) => {
    const chatIdStr = String(chatId);
    const currentId = getBackendIdForChat(chatIdStr);
    const requested = body.backend ? String(body.backend).trim() : "";
    const targetId = requested || currentId;

    // Only return a backend we already have a live instance for — never
    // boot one just to read its catalog. The chat's own backend is always
    // live; another backend is only listable while it's pooled.
    const instance =
      targetId === currentId
        ? getBackendForChat(chatIdStr)
        : getPooledBackend(targetId);

    if (!instance) {
      const avail = getAvailableBackends().map((b) => b.id);
      if (!avail.includes(targetId))
        return {
          ok: false,
          error: `Unknown backend "${targetId}". Available backends: ${avail.join(", ") || "(none)"}.`,
        };
      return {
        ok: false,
        error: `Backend "${targetId}" isn't currently active, so its model catalog isn't loaded. Switch this chat to it first, or call list_models with no argument to see this chat's backend ("${currentId}") models.`,
      };
    }

    const catalog = instance.models;
    if (!catalog?.listModels)
      return {
        ok: true,
        backend: targetId,
        models: [],
        text: `Backend "${targetId}" runs a fixed model (no selectable model catalog).`,
      };

    const { models } = await catalog.listModels("all");
    const selectable = models.filter((m) => m.selectable);
    const slim = selectable.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow,
      free: m.free ?? false,
    }));
    if (slim.length === 0)
      return {
        ok: true,
        backend: targetId,
        models: [],
        text: `Backend "${targetId}" exposes no selectable models.`,
      };
    const lines = slim.map((m) => {
      const bits = [
        m.reasoning ? "reasoning" : null,
        m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k ctx` : null,
        m.free ? "free" : null,
      ].filter(Boolean);
      const name =
        m.displayName && m.displayName !== m.id ? ` (${m.displayName})` : "";
      return `- ${m.id}${name}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
    });
    return {
      ok: true,
      backend: targetId,
      models: slim,
      text: `Selectable models on "${targetId}" (${slim.length}):\n${lines.join("\n")}`,
    };
  },

  list_backends: (body, chatId) => {
    const currentId = getBackendIdForChat(String(chatId));
    const backends = getAvailableBackends().map((b) => ({
      id: b.id,
      label: b.label,
      current: b.id === currentId,
    }));
    if (backends.length === 0)
      return { ok: true, backends: [], text: "No backends are available." };
    const lines = backends.map(
      (b) =>
        `- ${b.id}${b.label && b.label !== b.id ? ` (${b.label})` : ""}${b.current ? " — current" : ""}`,
    );
    return {
      ok: true,
      backends,
      text: `Available backends (${backends.length}):\n${lines.join("\n")}`,
    };
  },
};
