/**
 * Cross-frontend send — the server side of the `send_via` tool.
 *
 * A chat-free shared action: any session (an active Telegram chat, the
 * heartbeat, a dream run) delivers a message through ANY enabled
 * messaging frontend by naming it explicitly. Explicit is the point —
 * the gateway's normal chat_id routing infers the owning frontend from
 * the numeric id's shape, and WhatsApp's hash-derived ids also match the
 * Telegram matcher, so a cross-frontend send routed that way lands on
 * the wrong platform once the originating turn's context is cleared.
 *
 * Text is the common case; a media source (file_path / url / file_id)
 * promotes the send to the matching per-kind action (send_photo,
 * send_file, …), which every messaging frontend already implements and
 * already resolves `body.target` for. Without this, reaching another
 * platform meant text only — you could describe a photo to someone on
 * WhatsApp but not send them one.
 *
 * Core never imports src/frontend (dependency-cruiser enforces it), so
 * dispatch goes through a broker: `Gateway.registerFrontendHandler`
 * mirrors each frontend's action handler here, and the action calls the
 * target's own send action. A numeric target doubles as the handler's
 * chatId key, so id-addressed frontends (telegram, discord, teams,
 * native) need no changes; non-numeric forms (WhatsApp phone numbers,
 * wa_* ids) ride in `body.target` for the frontend's adapter to resolve.
 */

import type { FrontendActionHandler } from "../../types.js";
import type { SharedActionHandlers } from "./types.js";

const targets = new Map<string, FrontendActionHandler>();

/**
 * Broker registration — called by `Gateway.registerFrontendHandler` as
 * each frontend wires up (and with null on deregistration), so the set
 * of reachable targets is exactly the set of enabled frontends.
 */
export function registerCrossSendTarget(
  name: string,
  handler: FrontendActionHandler | null,
): void {
  if (handler === null) targets.delete(name);
  else targets.set(name, handler);
}

/**
 * Media kinds send_via can carry. Each maps to `send_<kind>`, the action
 * name every frontend's media handler already registers.
 */
const MEDIA_KINDS = [
  "photo",
  "video",
  "animation",
  "voice",
  "audio",
  "sticker",
  "video_note",
  "file",
] as const;

const MEDIA_KIND_SET: ReadonlySet<string> = new Set(MEDIA_KINDS);

/**
 * Extension → kind, so the common cases need no media_type. Anything
 * unrecognised travels as a document, which is the one kind that
 * accepts arbitrary bytes on every platform.
 */
const KIND_BY_EXT: Record<string, string> = {
  ".jpg": "photo",
  ".jpeg": "photo",
  ".png": "photo",
  ".webp": "photo",
  ".heic": "photo",
  ".gif": "animation",
  ".mp4": "video",
  ".mov": "video",
  ".mkv": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".m4a": "audio",
  ".flac": "audio",
  ".wav": "audio",
  ".ogg": "voice",
  ".opus": "voice",
};

/** Lowercased extension of a path or URL, "" when there isn't one. */
function extensionOf(source: string): string {
  let path = source;
  try {
    // Strip query/fragment so "a.png?v=2" still reads as .png.
    path = new URL(source).pathname;
  } catch {
    // Not a URL — a filesystem path, used as-is.
  }
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/**
 * Look up a registered frontend handler by name. Exported for the other
 * cross-frontend actions (account management), which need the same
 * broker and the same "is it enabled?" answer.
 */
export function crossSendTarget(
  name: string,
): FrontendActionHandler | undefined {
  return targets.get(name);
}

/** Enabled frontend names, for a "not enabled (enabled: …)" error. */
export function crossSendTargetNames(): string[] {
  return [...targets.keys()].sort();
}

export const crossSendHandlers: SharedActionHandlers = {
  send_via: async (body) => {
    const frontend = String(body.frontend ?? "")
      .trim()
      .toLowerCase();
    const target = String(body.target ?? "").trim();
    const text = String(body.text ?? "");
    const filePath = body.file_path ? String(body.file_path) : "";
    const url = body.url ? String(body.url) : "";
    const fileId = body.file_id ? String(body.file_id) : "";
    const hasMedia = Boolean(filePath || url || fileId);
    if (!frontend) {
      return { ok: false, error: "send_via: frontend is required" };
    }
    if (!target) {
      return { ok: false, error: "send_via: target is required" };
    }
    if (!hasMedia && !text.trim()) {
      return {
        ok: false,
        error:
          "send_via: text is required (or a media source: file_path, url, " +
          "or file_id)",
      };
    }
    const handler = crossSendTarget(frontend);
    if (!handler) {
      const enabled = crossSendTargetNames().join(", ") || "none";
      return {
        ok: false,
        error: `send_via: the ${frontend} frontend is not enabled (enabled: ${enabled})`,
      };
    }

    // Text-only keeps the exact shape it always had; a media source
    // promotes the send to the per-kind action, with text as the caption.
    let payload: Record<string, unknown>;
    let action: string;
    if (hasMedia) {
      const explicit = String(body.media_type ?? "")
        .trim()
        .toLowerCase();
      const kind =
        explicit || KIND_BY_EXT[extensionOf(filePath || url)] || "file";
      if (!MEDIA_KIND_SET.has(kind)) {
        return {
          ok: false,
          error:
            `send_via: unknown media_type "${kind}" — use one of ` +
            `${MEDIA_KINDS.join(", ")}`,
        };
      }
      action = `send_${kind}`;
      payload = { action, target };
      if (filePath) payload.file_path = filePath;
      if (url) payload.url = url;
      if (fileId) payload.file_id = fileId;
      if (text.trim()) payload.caption = text;
    } else {
      action = "send_message";
      payload = { action, text, target };
    }

    // A numeric target is the handler's chatId key; other forms travel in
    // body.target for the frontend's adapter to resolve. 0 is the same
    // "no chat" sentinel the chat-free dispatch itself uses.
    const numericTarget = /^-?\d+$/.test(target) ? Number(target) : 0;
    const result = await handler(payload, numericTarget);
    if (!result) {
      return {
        ok: false,
        error: `send_via: the ${frontend} frontend does not implement ${action}`,
      };
    }
    return result;
  },
};

/**
 * send_via is chat-free by design: it reads only its own explicit target
 * and the broker, so it stays reachable from heartbeat/background runs —
 * and skipping chat resolution is what keeps the wrong-frontend numeric
 * routing hazard out of the path entirely.
 */
export const crossSendChatFreeActions: ReadonlySet<string> = new Set([
  "send_via",
]);
