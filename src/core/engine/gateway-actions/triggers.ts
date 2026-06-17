/**
 * Trigger CRUD — create / list / cancel / logs / delete long-running watcher
 * scripts for a chat.
 */

import {
  addTrigger,
  deleteTrigger,
  generateTriggerId,
  getActiveTriggersForChat,
  getTrigger,
  getTriggerByName,
  getTriggersForChat,
  readTriggerLogTail,
  triggerLogPath,
  validateLanguage,
  validateName,
  validateScript,
  validateTimeout,
  writeScriptFile,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_ACTIVE_PER_CHAT,
  type TriggerLanguage,
} from "../../../storage/trigger-store.js";
import {
  cancelTrigger,
  spawnTrigger,
} from "../../background/triggers/index.js";
import { log } from "../../../util/log.js";
import { validateJobModelOverride } from "./shared.js";
import type { SharedActionHandlers } from "./types.js";

export const triggerHandlers: SharedActionHandlers = {
  trigger_create: async (body, chatId) => {
    const name = String(body.name ?? "").trim();
    const language = body.language;
    const script = String(body.script ?? "");
    const timeoutSeconds =
      body.timeout_seconds != null
        ? Number(body.timeout_seconds)
        : DEFAULT_TIMEOUT_SECONDS;
    const description = body.description ? String(body.description) : undefined;
    const persistent = body.persistent === true;
    const model = body.model ? String(body.model) : undefined;

    const nameErr = validateName(name);
    if (nameErr) return { ok: false, error: nameErr };
    if (!validateLanguage(language))
      return {
        ok: false,
        error: `Unsupported language. Choose one of: bash, python, node, lua`,
      };
    const scriptErr = validateScript(script);
    if (scriptErr) return { ok: false, error: scriptErr };
    const timeoutErr = validateTimeout(timeoutSeconds);
    if (timeoutErr) return { ok: false, error: timeoutErr };

    const chatIdStr = String(chatId);
    if (getTriggerByName(chatIdStr, name)) {
      return {
        ok: false,
        error: `A trigger named "${name}" already exists in this chat. Cancel it first or pick a different name.`,
      };
    }
    const active = getActiveTriggersForChat(chatIdStr);
    if (active.length >= MAX_ACTIVE_PER_CHAT) {
      return {
        ok: false,
        error: `Per-chat trigger cap reached (${MAX_ACTIVE_PER_CHAT} active). Cancel one before creating another.`,
      };
    }

    const numericChatId = Number(chatId);
    if (!Number.isFinite(numericChatId)) {
      return {
        ok: false,
        error: `Cannot derive numeric chatId from ${chatId}`,
      };
    }

    // Validate the model up front so a bad id is rejected here instead of
    // silently failing at fire time.
    if (model) {
      const modelErr = await validateJobModelOverride(chatId, model);
      if (modelErr) return { ok: false, error: modelErr };
    }

    const id = generateTriggerId();
    const lang = language as TriggerLanguage;
    let scriptPath: string;
    try {
      scriptPath = writeScriptFile(chatIdStr, id, lang, script);
    } catch (err) {
      return {
        ok: false,
        error: `Failed to write script: ${err instanceof Error ? err.message : err}`,
      };
    }
    const logPath = triggerLogPath(chatIdStr, id);

    const trigger = {
      id,
      chatId: chatIdStr,
      numericChatId,
      name,
      language: lang,
      scriptPath,
      logPath,
      description,
      status: "pending" as const,
      createdAt: Date.now(),
      timeoutSeconds,
      fireCount: 0,
      persistent,
      ...(model ? { model } : {}),
    };
    addTrigger(trigger);

    try {
      spawnTrigger(trigger);
    } catch (err) {
      return {
        ok: false,
        error: `Failed to spawn: ${err instanceof Error ? err.message : err}`,
      };
    }

    // spawnTrigger() can fail without throwing — e.g. an unsupported
    // language slips past the validateLanguage() check (defence in depth),
    // child.pid is undefined, or spawn() itself catches and routes through
    // failTrigger(). In all of those paths the trigger lands in `errored`
    // with `lastError` set. Re-read the store and surface the real status
    // so callers never get a false "running" response.
    const stored = getTrigger(id);
    if (!stored || stored.status === "errored") {
      return {
        ok: false,
        error: stored?.lastError ?? "Failed to spawn (unknown error)",
      };
    }

    log("gateway", `trigger_create: "${name}" [${id}] (${lang})`);
    return {
      ok: true,
      text:
        `Created trigger "${name}" (id: ${id})\n` +
        `Language: ${lang}\n` +
        `Timeout: ${timeoutSeconds}s\n` +
        `Persistent: ${persistent ? "yes (respawns on Talon restart)" : "no"}\n` +
        `Status: ${stored.status}`,
    };
  },

  trigger_list: (body, chatId) => {
    const triggers = getTriggersForChat(String(chatId));
    if (triggers.length === 0)
      return { ok: true, text: "No triggers in this chat." };
    const lines = triggers.map((t) => {
      const created = new Date(t.createdAt)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      const fireInfo =
        t.fireCount > 0
          ? `${t.fireCount} fire(s)${t.lastFireAt ? `, last ${new Date(t.lastFireAt).toISOString().slice(0, 19).replace("T", " ")}` : ""}`
          : "no fires yet";
      const detail = [
        `- ${t.name} [${t.status}]${t.persistent ? " (persistent)" : ""}`,
        `  ID: ${t.id}`,
        `  Language: ${t.language}`,
        `  Created: ${created} (timeout ${t.timeoutSeconds}s)`,
        `  ${fireInfo}`,
      ];
      if (t.description) detail.push(`  Note: ${t.description}`);
      if (t.lastError) detail.push(`  Error: ${t.lastError}`);
      return detail.join("\n");
    });
    return {
      ok: true,
      text: `Triggers (${triggers.length}):\n\n${lines.join("\n\n")}`,
    };
  },

  trigger_cancel: (body, chatId) => {
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { ok: false, error: "Missing trigger_id" };
    const t = getTrigger(triggerId);
    if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
    if (t.chatId !== String(chatId))
      return { ok: false, error: "Trigger belongs to a different chat" };
    const wasRunning = cancelTrigger(triggerId);
    if (!wasRunning) {
      return {
        ok: true,
        text: `Trigger "${t.name}" (${triggerId}) was already in status "${t.status}".`,
      };
    }
    return {
      ok: true,
      text: `Cancelled trigger "${t.name}" (${triggerId}). SIGTERM sent; SIGKILL after 5s grace.`,
    };
  },

  trigger_logs: (body, chatId) => {
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { ok: false, error: "Missing trigger_id" };
    const t = getTrigger(triggerId);
    if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
    if (t.chatId !== String(chatId))
      return { ok: false, error: "Trigger belongs to a different chat" };
    const lines = Math.min(500, Math.max(1, Number(body.lines ?? 80)));
    const { tail, truncated } = readTriggerLogTail(t.logPath, lines);
    const preface =
      `Trigger "${t.name}" (${triggerId}) — status ${t.status}` +
      (truncated ? `, showing last ${lines} lines:` : `:`);
    return {
      ok: true,
      text: `${preface}\n\n${tail || "(empty)"}`,
    };
  },

  trigger_delete: (body, chatId) => {
    const triggerId = String(body.trigger_id ?? "");
    if (!triggerId) return { ok: false, error: "Missing trigger_id" };
    const t = getTrigger(triggerId);
    if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
    if (t.chatId !== String(chatId))
      return { ok: false, error: "Trigger belongs to a different chat" };
    // Cancel first if it's still running so we don't orphan a child
    cancelTrigger(triggerId);
    deleteTrigger(triggerId);
    return {
      ok: true,
      text: `Deleted trigger "${t.name}" (${triggerId}).`,
    };
  },
};
