/**
 * Native chat registry — the set of conversations the bridge exposes.
 *
 * Each chat maps a string id (`d_…`) to the stable 32-bit numeric id the
 * engine routes on. Chats with a persisted session survive a daemon restart
 * (restored from the session/history stores); brand-new empty chats live only
 * in memory until their first message persists them.
 */

import {
  generateNativeChatId,
  deriveNumericChatId,
  isNativeChatId,
} from "../../util/chat-id.js";
import {
  getAllSessions,
  setSessionName,
  deleteSession,
} from "../../storage/sessions.js";
import { getRecentHistory, clearHistory } from "../../storage/history.js";
import { previewOf } from "./protocol.js";

export type ChatEntry = {
  id: string;
  numericId: number;
  title: string;
  createdAt: number;
  lastActive: number;
  preview: string;
};

/** The placeholder title a chat carries until it earns a real one. */
export const DEFAULT_CHAT_TITLE = "New chat";

function defaultTitle(): string {
  return DEFAULT_CHAT_TITLE;
}

export class NativeChats {
  private byId = new Map<string, ChatEntry>();
  private byNum = new Map<number, ChatEntry>();

  /**
   * Re-hydrate chats that have a persisted session (i.e. at least one prior
   * turn). Called once at startup so the sidebar isn't empty after a restart.
   */
  restore(): void {
    for (const { chatId, info } of getAllSessions()) {
      if (!isNativeChatId(chatId)) continue;
      const recent = getRecentHistory(chatId, 1);
      const entry: ChatEntry = {
        id: chatId,
        numericId: deriveNumericChatId(chatId),
        title: info.sessionName || defaultTitle(),
        createdAt: info.createdAt || Date.now(),
        lastActive: info.lastActive || Date.now(),
        preview: recent.length ? previewOf(recent[recent.length - 1].text) : "",
      };
      this.index(entry);
    }
  }

  create(title?: string): ChatEntry {
    const id = generateNativeChatId();
    const trimmed = title?.trim();
    const entry: ChatEntry = {
      id,
      numericId: deriveNumericChatId(id),
      title: trimmed || defaultTitle(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      preview: "",
    };
    this.index(entry);
    if (trimmed) setSessionName(id, trimmed);
    return entry;
  }

  /** Return an existing chat, or adopt a client-supplied id (deep link / sync). */
  ensure(id: string): ChatEntry {
    const existing = this.byId.get(id);
    if (existing) return existing;
    const entry: ChatEntry = {
      id,
      numericId: deriveNumericChatId(id),
      title: defaultTitle(),
      createdAt: Date.now(),
      lastActive: Date.now(),
      preview: "",
    };
    this.index(entry);
    return entry;
  }

  get(id: string): ChatEntry | undefined {
    return this.byId.get(id);
  }

  byNumeric(numericId: number): ChatEntry | undefined {
    return this.byNum.get(numericId);
  }

  /** Most-recently-active first. */
  list(): ChatEntry[] {
    return [...this.byId.values()].sort((a, b) => b.lastActive - a.lastActive);
  }

  count(): number {
    return this.byId.size;
  }

  rename(id: string, title: string): ChatEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    const trimmed = title.trim();
    if (trimmed) {
      entry.title = trimmed;
      setSessionName(id, trimmed);
    }
    return entry;
  }

  remove(id: string): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.byId.delete(id);
    this.byNum.delete(entry.numericId);
    deleteSession(id);
    clearHistory(id);
    return true;
  }

  /** Bump activity + refresh the preview when a message lands. */
  touch(id: string, preview?: string): ChatEntry | undefined {
    const entry = this.byId.get(id);
    if (!entry) return undefined;
    entry.lastActive = Date.now();
    if (preview !== undefined) entry.preview = previewOf(preview);
    return entry;
  }

  private index(entry: ChatEntry): void {
    this.byId.set(entry.id, entry);
    this.byNum.set(entry.numericId, entry);
  }
}
