/**
 * Bridge server handlers — the table that binds the transport's routes
 * (server.ts) to the runtime modules. Each entry is a one-line delegation;
 * anything with logic of its own lives in the module named for it.
 */

import { files } from "../../util/paths.js";
import { setChatPulse } from "../../storage/chat-settings.js";
import { getPooledBackend } from "../../core/engine/backend-controller/index.js";
import { createChat, deleteChat, renameChat } from "./chat-lifecycle.js";
import { broadcastChatUpdated, toClientChat } from "./chat-wire.js";
import { control } from "./control.js";
import {
  pluginItems,
  skillItems,
  togglePlugin,
  toggleSkill,
} from "./extensions.js";
import { historyPage, searchHistory } from "./history.js";
import { readLogEntries } from "./logs.js";
import { mediaUrl, registerMedia, saveUpload } from "./media.js";
import {
  effortLevels,
  listBackends,
  listModels,
  setBackend,
  setEffort,
  setModel,
} from "./models.js";
import { setQueued } from "./queue.js";
import { resetChat } from "./reset.js";
import type { NativeRuntime } from "./runtime.js";
import type { BridgeServerHandlers } from "./server.js";
import { configSnapshot, applyConfigUpdate } from "./settings.js";
import { bridgeStatus, broadcastStatus } from "./status.js";
import { interruptTurn, isBusy, liveTurnEvents, startTurn } from "./turn.js";

export function buildBridgeHandlers(
  runtime: NativeRuntime,
): BridgeServerHandlers {
  const { chats, config, mesh } = runtime;
  return {
    status: () => bridgeStatus(runtime),
    listChats: () => chats.list().map((entry) => toClientChat(runtime, entry)),
    createChat: (title) => createChat(runtime, title),
    renameChat: (id, title) => renameChat(runtime, id, title),
    deleteChat: (id) => deleteChat(runtime, id),
    history: (id, opts) => historyPage(runtime, id, opts),
    search: (query, chatId) => searchHistory(runtime, query, chatId),
    send: (id, text, opts) => {
      const entry = chats.get(id) ?? chats.ensure(id);
      // A turn is already running for this chat — don't interrupt it. Park the
      // message as the single queued follow-up (synced to every client); it
      // auto-sends when the running turn ends. `isBusy` reads `liveTurns`,
      // which `runTurn` sets synchronously, so even a rapid second /send from
      // any client is caught here rather than starting a concurrent turn.
      if (isBusy(runtime, entry.id)) {
        setQueued(runtime, entry.id, {
          text,
          imagePath: opts?.imagePath,
          attachmentPath: opts?.attachmentPath,
        });
        return;
      }
      startTurn(runtime, entry, text, opts);
    },
    queueMessage: (id, text) => {
      // Edit/replace the queued follow-up (text-only). Empty clears it.
      const entry = chats.get(id);
      if (entry) setQueued(runtime, entry.id, { text });
    },
    upload: async (filename, _contentType, bytes) => {
      const path = await saveUpload(runtime, filename, bytes);
      return { imagePath: mediaUrl(registerMedia(runtime, path)), path };
    },
    listModels: (chatId) => listModels(runtime, chatId),
    setModel: (id, model) => setModel(runtime, id, model),
    listBackends: (id) => listBackends(runtime, id),
    setBackend: (id, backend) => setBackend(runtime, id, backend),
    setEffort: (id, effort) => setEffort(runtime, id, effort),
    effortLevels: (id) => effortLevels(runtime, id),
    interruptTurn: (id) => interruptTurn(runtime, id),
    resetChat: (id) => resetChat(runtime, id),
    setPulse: (id, on) => {
      const entry = chats.get(id);
      if (!entry) return;
      setChatPulse(id, on);
      broadcastChatUpdated(runtime, entry);
    },
    getConfig: () => configSnapshot(config),
    setConfig: (update) => {
      const snap = applyConfigUpdate(config, update);
      broadcastStatus(runtime);
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
    liveTurnEvents: () => liveTurnEvents(runtime),
    mediaPath: (id) => runtime.media.get(id) ?? null,
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
    openCompanionPair: (token, format) => mesh.openCompanionPair(token, format),
    openNodeInstall: (token) => mesh.openNodeInstall(token),
    openNodeBinary: (token) => mesh.openNodeBinary(token),
  };
}
