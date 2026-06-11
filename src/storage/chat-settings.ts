/**
 * Per-chat runtime settings. Overrides global config on a per-chat basis.
 *
 * Persisted via the unified `JsonStore<T>` envelope at
 * `~/.talon/data/chat-settings.json`. A migrate hook accepts the
 * pre-envelope bare-object shape so existing on-disk state loads
 * unchanged. The two intra-data migrations — legacy
 * `maxThinkingTokens` → `effort` and single-slot `model` →
 * `modelByBackend` — still run in `loadChatSettings` /
 * `migrateLegacyModelField` and remain idempotent.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";
import { JsonStore } from "../core/agent-runtime/store.js";
import type { ReasoningEffortLevel } from "../core/types.js";

export type EffortLevel = ReasoningEffortLevel;

export type ChatSettings = {
  /**
   * Per-backend model overrides for this chat. Keyed by backend id
   * (`"claude"`, `"codex"`, `"openai-agents"`, etc). Each entry is the
   * model id the user picked on that backend.
   *
   * Switching backends preserves each side's last pick — your Codex
   * chat remembers `gpt-5.5`, your OpenRouter chat remembers
   * `meta-llama/...`. Replaces the single legacy `model` field which
   * couldn't differentiate per-backend choices and produced the
   * orphan-bug class (model from backend X persisting when switching
   * to backend Y).
   *
   * Resolution order (see `core/models/active-model.ts`):
   *   1. `modelByBackend[activeBackend]` if it validates on the catalog
   *   2. `backend.getDefaultModel()` (canonical for backends that have one)
   *   3. `config.backendDefaults[activeBackend]` (operator override)
   *   4. `config.model` (only when activeBackend === config.backend)
   *   5. null → "No model selected" UI + send guard refuses.
   */
  modelByBackend?: Record<string, string>;
  /**
   * @deprecated Single-slot model field. Retained for back-compat with
   * old stores; migrated into `modelByBackend` on load. New writes go
   * through `setChatModelForBackend` instead.
   */
  model?: string;
  /**
   * Backend override for this chat. When set, queries from this chat
   * route to the override backend instead of the global `config.backend`.
   * The backend controller refcounts pool instances, so two chats on
   * two different backends keep both alive concurrently.
   *
   * Stored as the registry id (e.g. `"claude"`, `"openai-agents"`).
   * Cleared via `setChatBackend(cid, undefined)` — chat reverts to
   * the global default.
   */
  backend?: string;
  /** Effort level override (maps to SDK thinking + effort options). */
  effort?: EffortLevel;
  /** Whether pulse is enabled for this chat. */
  pulse?: boolean;
  /** Per-chat pulse check interval in milliseconds. */
  pulseIntervalMs?: number;
  /** Last message ID checked by pulse (persisted to avoid reprocessing on restart). */
  pulseLastCheckMsgId?: number;
  /**
   * When true, the model picker filters to free-tier models by default.
   * Only meaningful for backends that report free-tier metadata (currently
   * `openai-agents` against OpenRouter); other backends ignore the flag.
   */
  freeOnly?: boolean;
};

type ChatSettingsStore = Record<string, ChatSettings>;

const STORE_FILE = files.chatSettings;
const SCHEMA_VERSION = 1 as const;

const store = new JsonStore<ChatSettingsStore>({
  path: STORE_FILE,
  defaultValue: {},
  schemaVersion: SCHEMA_VERSION,
  migrate: (raw, fromVersion) => {
    if (fromVersion !== 0) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { value: {}, schemaVersion: SCHEMA_VERSION };
    }
    return {
      value: raw as ChatSettingsStore,
      schemaVersion: SCHEMA_VERSION,
    };
  },
});

export function loadChatSettings(): void {
  store.reset();
  try {
    store.loadSync();
  } catch (err) {
    logError("settings", "Failed to load chat settings", err);
  }

  // Migrate legacy maxThinkingTokens → effort.
  let migrated = 0;
  const data = store.get();
  for (const [chatId, settings] of Object.entries(data)) {
    const raw = settings as Record<string, unknown>;
    if ("maxThinkingTokens" in raw && !settings.effort) {
      const tokens = Number(raw.maxThinkingTokens);
      let effort: EffortLevel;
      if (tokens === 0) effort = "off";
      else if (tokens <= 2000) effort = "low";
      else if (tokens <= 8000) effort = "medium";
      else if (tokens <= 16000) effort = "high";
      else effort = "max";
      settings.effort = effort;
      delete raw.maxThinkingTokens;
      migrated++;
      log(
        "settings",
        `Migrated chat ${chatId}: maxThinkingTokens=${tokens} to effort=${effort}`,
      );
    } else if ("maxThinkingTokens" in raw) {
      // Has effort already, just clean up the old field
      delete raw.maxThinkingTokens;
      migrated++;
    }
  }
  if (migrated > 0) {
    store.update(() => undefined);
    save();
    log(
      "settings",
      `Migrated ${migrated} chat(s) from maxThinkingTokens to effort`,
    );
  }
  // The legacy `model` field is not destructively migrated here — that
  // requires knowing the chat's effective backend, which isn't available
  // at load time (backend pool initialises later). Instead `setChatModel`
  // mirrors writes into `modelByBackend` and the active-model resolver
  // reads both, preferring the per-backend slot.
}

/**
 * Migrate the legacy single-slot `model` field into the per-backend
 * map. Idempotent. Call this once the global backend id is known
 * (typically right after config + backend pool initialise) so the
 * legacy value lands in the right per-backend slot.
 *
 * For each chat with a legacy `model` set: copy it into
 * `modelByBackend[chat's effective backend]` if no entry exists there
 * yet, then delete the legacy field. Chats whose effective backend
 * isn't in the runtime registry (e.g. user removed it from
 * `enabledBackends`) keep the legacy field — the resolver still uses
 * it as the lowest-precedence fallback so behaviour doesn't regress.
 */
export function migrateLegacyModelField(
  fallbackBackendId: string,
  isRecognisedBackend: (id: string) => boolean,
): void {
  let migrated = 0;
  const data = store.get();
  for (const [chatId, settings] of Object.entries(data)) {
    if (typeof settings.model !== "string" || !settings.model) continue;
    const effectiveBackend =
      settings.backend && isRecognisedBackend(settings.backend)
        ? settings.backend
        : isRecognisedBackend(fallbackBackendId)
          ? fallbackBackendId
          : null;
    if (!effectiveBackend) continue;
    if (!settings.modelByBackend) settings.modelByBackend = {};
    if (settings.modelByBackend[effectiveBackend] === undefined) {
      settings.modelByBackend[effectiveBackend] = settings.model;
    }
    delete settings.model;
    migrated++;
    log(
      "settings",
      `Migrated chat ${chatId}: legacy model → modelByBackend[${effectiveBackend}]`,
    );
  }
  if (migrated > 0) {
    store.update(() => undefined);
    save();
    log(
      "settings",
      `Migrated ${migrated} chat(s) from legacy model → modelByBackend`,
    );
  }
}

function save(): void {
  if (!store.isDirty()) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    store.saveSync();
  } catch (err) {
    logError("settings", "Failed to persist chat settings", err);
    recordError(
      `Settings save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const autoSaveTimer = setInterval(save, 10_000);
registerCleanup(save);

/** Flush settings to disk and stop the auto-save timer. */
export function flushChatSettings(): void {
  clearInterval(autoSaveTimer);
  store.update(() => undefined);
  save();
}

/**
 * Snapshot of every persisted chat's settings, keyed by chat id.
 * Returns a shallow copy of the in-memory store — callers should
 * NOT mutate the returned object or its values (use the typed
 * setters instead).
 */
export function getAllChatSettings(): Record<string, ChatSettings> {
  return { ...store.get() };
}

export function getChatSettings(chatId: string): ChatSettings {
  return store.get()[chatId] ?? {};
}

function cleanupEmpty(data: ChatSettingsStore, chatId: string): void {
  const s = data[chatId];
  if (!s) return;
  const modelByBackendEmpty =
    !s.modelByBackend || Object.keys(s.modelByBackend).length === 0;
  if (
    !s.model &&
    modelByBackendEmpty &&
    !s.backend &&
    !s.effort &&
    s.pulse === undefined &&
    s.pulseIntervalMs === undefined &&
    s.pulseLastCheckMsgId === undefined &&
    s.freeOnly === undefined
  ) {
    delete data[chatId];
  }
}

/** Get-or-create a settings entry inside a JsonStore update closure. */
function ensureEntry(data: ChatSettingsStore, chatId: string): ChatSettings {
  if (!data[chatId]) data[chatId] = {};
  return data[chatId];
}

export function setPulseLastCheckMsgId(
  chatId: string,
  msgId: number | undefined,
): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (msgId !== undefined) {
      entry.pulseLastCheckMsgId = msgId;
    } else {
      delete entry.pulseLastCheckMsgId;
      cleanupEmpty(data, chatId);
    }
  });
  // Don't force-save on every pulse check — let the auto-save interval handle it
}

/**
 * Set the per-chat model override for a specific backend. Pass
 * `undefined` to clear that backend's slot only. Other backends'
 * persisted picks are left intact — switching backends and back
 * restores each side's prior choice.
 */
export function setChatModelForBackend(
  chatId: string,
  backendId: string,
  model: string | undefined,
): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (model) {
      if (!entry.modelByBackend) entry.modelByBackend = {};
      entry.modelByBackend[backendId] = model;
    } else if (entry.modelByBackend) {
      delete entry.modelByBackend[backendId];
      if (Object.keys(entry.modelByBackend).length === 0) {
        delete entry.modelByBackend;
      }
    }
    cleanupEmpty(data, chatId);
  });
  save();
}

/**
 * Get the per-chat model override for a specific backend. Returns
 * `undefined` when no per-chat pick exists for that backend; callers
 * (typically the active-model resolver) fall through to the backend's
 * own default + config in that case.
 */
export function getChatModelForBackend(
  chatId: string,
  backendId: string,
): string | undefined {
  const settings = store.get()[chatId];
  if (!settings) return undefined;
  const fromMap = settings.modelByBackend?.[backendId];
  if (fromMap) return fromMap;
  // Legacy fallback: pre-migration stores hold a single `model` field
  // with no backend tag. Treat it as the value for the chat's current
  // backend (or the global default backend if no per-chat binding).
  // Once `migrateLegacyModelField` runs this branch becomes dead.
  if (typeof settings.model === "string" && settings.model) {
    if (settings.backend ? settings.backend === backendId : true) {
      return settings.model;
    }
  }
  return undefined;
}

/**
 * Clear every per-backend model override on a chat. Used by `/reset`
 * and admin tooling. Equivalent to deleting `modelByBackend` whole.
 */
export function clearAllChatModels(chatId: string): void {
  if (!store.get()[chatId]) return;
  store.update((data) => {
    const entry = data[chatId];
    if (!entry) return;
    delete entry.modelByBackend;
    delete entry.model;
    cleanupEmpty(data, chatId);
  });
  save();
}

/**
 * @deprecated Prefer `setChatModelForBackend(chatId, backendId, model)`
 * which is explicit about which backend's slot is being mutated.
 *
 * Legacy single-slot setter. Writes to the chat's currently bound
 * backend's slot when a binding exists, otherwise to the legacy
 * `model` field (typical only on fresh / pre-migration chats).
 *
 * Pass `undefined` to clear the model state. The clear semantic
 * matches legacy expectations: removes EVERY per-backend slot AND
 * the legacy field — equivalent to "user hit reset on this chat".
 * For per-backend granularity use `setChatModelForBackend` with
 * `undefined` instead.
 */
export function setChatModel(chatId: string, model: string | undefined): void {
  if (model === undefined) {
    // Legacy "reset everything" semantic. Matches what existing
    // callers / tests expect when they call setChatModel(cid, undefined).
    store.update((data) => {
      const entry = ensureEntry(data, chatId);
      delete entry.modelByBackend;
      delete entry.model;
      cleanupEmpty(data, chatId);
    });
    save();
    return;
  }

  const existing = store.get()[chatId];
  const targetBackend = existing?.backend;
  if (targetBackend) {
    setChatModelForBackend(chatId, targetBackend, model);
    return;
  }
  // No backend binding — write to the legacy slot. The next backend
  // switch / migration will pick it up into modelByBackend.
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    entry.model = model;
  });
  save();
}

/**
 * Per-chat backend override. Pass `undefined` to clear the override
 * (chat reverts to `config.backend`). The backend pool's per-chat
 * acquire/release happens separately via `rebindChat` / `releaseChat`
 * — this setter only persists the choice.
 */
export function setChatBackend(
  chatId: string,
  backend: string | undefined,
): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (backend) {
      entry.backend = backend;
    } else {
      delete entry.backend;
      cleanupEmpty(data, chatId);
    }
  });
  save();
}

export function setChatEffort(
  chatId: string,
  effort: EffortLevel | undefined,
): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (effort) {
      entry.effort = effort;
    } else {
      delete entry.effort;
      cleanupEmpty(data, chatId);
    }
  });
  save();
}

export function setChatFreeOnly(chatId: string, on: boolean | undefined): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (on) {
      entry.freeOnly = true;
    } else {
      delete entry.freeOnly;
      cleanupEmpty(data, chatId);
    }
  });
  save();
}

export function setChatPulse(
  chatId: string,
  enabled: boolean | undefined,
): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (enabled !== undefined) {
      entry.pulse = enabled;
    } else {
      delete entry.pulse;
      cleanupEmpty(data, chatId);
    }
  });
  save();
}

export function setChatPulseInterval(
  chatId: string,
  intervalMs: number | undefined,
): void {
  store.update((data) => {
    const entry = ensureEntry(data, chatId);
    if (intervalMs !== undefined) {
      entry.pulseIntervalMs = intervalMs;
    } else {
      delete entry.pulseIntervalMs;
      cleanupEmpty(data, chatId);
    }
  });
  save();
}

/** Get all chat IDs that have pulse enabled in settings. */
export function getRegisteredPulseChats(): string[] {
  return Object.entries(store.get())
    .filter(([, s]) => s.pulse === true)
    .map(([id]) => id);
}

/** Valid effort levels. */
export const EFFORT_LEVELS: EffortLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
];

/**
 * Resolve a user-provided model name (alias or full ID) to the canonical model ID.
 * Delegates to the model registry; falls through unknown names unchanged.
 */
export { resolveModelId as resolveModelName } from "../core/models/catalog.js";
