/**
 * Guest DM tool scope.
 *
 * Anyone the operator lets DM the bot gets the same agent the operator
 * gets: shell, files, mail, mesh devices, cron, memory, cross-chat sends.
 * With `guestDmScope.enabled`, a DM from anyone who is not an operator gets a
 * conversation-only surface instead, enforced here in the hub, so it holds
 * for every backend that reaches tools through the hub:
 *
 *   - Talon tools: an explicit allowlist (reply, react, edit/delete own
 *     messages, read this chat's history and media, look at stickers).
 *     Nothing that runs code, touches files, schedules, remembers, spawns
 *     agents, reaches devices or acts on another chat.
 *   - Parameters: a guest session may only target its own chat and may
 *     never attach a local file by path (`send(file_path=…)` would
 *     otherwise read any file the daemon can read and hand it over).
 *   - Plugin servers: only those named in `guestPlugins` (default: web
 *     search and the time/weather/currency extras).
 *
 * Groups are untouched: they already require the operator's membership,
 * and their tool surface is a separate decision.
 *
 * Backend built-ins that live outside the hub (the Claude SDK's own
 * Bash/Read/Write, Codex's shell) are the backend's job. The Claude SDK
 * backend drops its built-ins for guest chats (see claude-sdk/options.ts).
 */

export type GuestDmScopeConfig = {
  enabled?: boolean;
  /** Chat ids that keep the full surface in addition to the admin's DM. */
  operatorChats?: readonly string[];
  /** Plugin/hub server names a guest DM may use. */
  guestPlugins?: readonly string[];
};

export const DEFAULT_GUEST_PLUGINS: readonly string[] = [
  "brave-search",
  "extras-tools",
];

/** Talon tools a guest DM may see and call. Everything else is hidden. */
export const GUEST_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "end_turn",
  "send",
  "react",
  "edit_message",
  "delete_message",
  "stop_poll",
  "get_chat_info",
  "read_chat_history",
  "search_chat_history",
  "get_message_by_id",
  "download_media",
  "list_media",
  "get_sticker_pack",
  "download_sticker",
]);

/** Parameters that name another chat. A guest may only name its own. */
const CHAT_TARGET_PARAMS = ["chat_id", "to_chat_id", "from_chat_id"] as const;

type ScopeState = {
  enabled: boolean;
  operators: Set<string>;
  plugins: Set<string>;
};

let state: ScopeState = {
  enabled: false,
  operators: new Set(),
  plugins: new Set(DEFAULT_GUEST_PLUGINS),
};

/** Set at bootstrap (and on config reload). */
export function initGuestDmScope(
  cfg: GuestDmScopeConfig | undefined,
  adminUserId?: number,
): void {
  const operators = new Set<string>(cfg?.operatorChats ?? []);
  if (adminUserId) operators.add(String(adminUserId));
  state = {
    enabled: cfg?.enabled === true,
    operators,
    plugins: new Set(cfg?.guestPlugins ?? DEFAULT_GUEST_PLUGINS),
  };
}

/**
 * Is this chat id a one-to-one DM? Telegram DMs are the peer's positive
 * user id; WhatsApp DMs are `wa_dm_<number>`. Anything else (groups,
 * Discord, native, heartbeat) is not treated as a DM here.
 */
export function isDmChatId(chatId: string): boolean {
  return /^\d+$/.test(chatId) || chatId.startsWith("wa_dm_");
}

/** Should this chat get the guest surface? */
export function isGuestChat(chatId: string): boolean {
  if (!state.enabled) return false;
  if (!isDmChatId(chatId)) return false;
  return !state.operators.has(chatId);
}

export function isGuestToolAllowed(name: string): boolean {
  return GUEST_TOOL_ALLOWLIST.has(name);
}

export function isGuestPluginAllowed(serverName: string): boolean {
  return state.plugins.has(serverName);
}

/**
 * Why a guest call with these params must be refused, or null if it is
 * fine. Checked on every guest tool call, after the allowlist.
 */
export function guestParamViolation(
  chatId: string,
  params: Record<string, unknown>,
): string | null {
  for (const key of CHAT_TARGET_PARAMS) {
    const v = params[key];
    if (v !== undefined && v !== null && String(v) !== chatId) {
      return `${key} must be this chat`;
    }
  }
  if (params.file_path !== undefined) {
    return "file_path is not available here; use a url or file_id";
  }
  const media = params.media;
  if (Array.isArray(media)) {
    for (const item of media) {
      if (
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).file_path !== undefined
      ) {
        return "file_path is not available here; use a url or file_id";
      }
    }
  }
  return null;
}
