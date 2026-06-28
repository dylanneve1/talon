/**
 * Model / backend discovery — `list_models` and `list_backends`.
 *
 * A non-active backend may be booted transiently to read its catalog, then
 * released immediately so `list_models backend=<id>` can inspect any
 * registered provider without switching the chat.
 */

import {
  getBackendForChat,
  getBackendIdForChat,
  getAvailableBackends,
  getPooledBackend,
  acquireBackendInstance,
} from "../backend-controller/index.js";
import type { SharedActionHandlers } from "./types.js";

export const modelHandlers: SharedActionHandlers = {
  list_models: async (body, chatId) => {
    const chatIdStr = String(chatId);
    const currentId = getBackendIdForChat(chatIdStr);
    const requested = body.backend ? String(body.backend).trim() : "";
    const targetId = requested || currentId;

    const avail = getAvailableBackends().map((b) => b.id);
    if (!avail.includes(targetId))
      return {
        ok: false,
        error: `Unknown backend "${targetId}". Available backends: ${avail.join(", ") || "(none)"}.`,
      };

    // Prefer a live instance (the chat's backend, or one already pooled).
    // For any other registered backend, boot it transiently to read its
    // catalog, then tear it back down so we never leak an instance.
    let instance =
      targetId === currentId
        ? getBackendForChat(chatIdStr)
        : getPooledBackend(targetId);
    let release: (() => Promise<void>) | null = null;
    if (!instance) {
      try {
        const acquired = await acquireBackendInstance(targetId);
        instance = acquired.backend;
        release = acquired.release;
      } catch (err) {
        return {
          ok: false,
          error: `Could not load backend "${targetId}" to read its models: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
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
      const note = targetId === currentId ? "" : " (not this chat's backend)";
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
        text: `Selectable models on "${targetId}"${note} (${slim.length}):\n${lines.join("\n")}`,
      };
    } finally {
      if (release) await release();
    }
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
