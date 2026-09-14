import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { asPositiveInt, asString, deviceIdParam } from "./params.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function chatRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "GET /events"
  | "GET /chats"
  | "POST /chats"
  | "POST /chats/rename"
  | "POST /chats/delete"
  | "POST /chats/reset"
  | "POST /chats/interrupt"
  | "POST /chats/pulse"
  | "POST /queue"
  | "GET /history"
  | "GET /search"
  | "POST /send"
  | "POST /upload"
  | "GET /media"
> {
  const { json, readJson, handlers: h } = host;
  return {
    // ── Chats ──────────────────────────────────────────────────────────

    // A mesh client names itself here so device-addressed events reach
    // it alone (see sendToDevice); UI clients simply omit it.
    "GET /events": ({ res, url }) => host.openStream(res, deviceIdParam(url)),
    "GET /chats": ({ res }) => json(res, 200, { chats: h.listChats() }),
    "POST /chats": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, { chat: h.createChat(asString(body.title)) });
    },
    "POST /chats/rename": async ({ req, res }) => {
      const body = await readJson(req);
      const chat = h.renameChat(
        asString(body.chatId) ?? "",
        asString(body.title) ?? "",
      );
      return chat
        ? json(res, 200, { chat })
        : json(res, 404, { ok: false, error: "No such chat" });
    },
    "POST /chats/delete": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, { ok: h.deleteChat(asString(body.chatId) ?? "") });
    },
    "POST /chats/reset": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, { ok: h.resetChat(asString(body.chatId) ?? "") });
    },
    "POST /chats/interrupt": async ({ req, res }) => {
      const body = await readJson(req);
      const ok = await h.interruptTurn(asString(body.chatId) ?? "");
      json(res, 200, { ok });
    },
    "POST /chats/pulse": async ({ req, res }) => {
      const body = await readJson(req);
      h.setPulse(asString(body.chatId) ?? "", body.on === true);
      json(res, 200, { ok: true });
    },
    "POST /queue": async ({ req, res }) => {
      const body = await readJson(req);
      h.queueMessage(asString(body.chatId) ?? "", asString(body.text) ?? "");
      json(res, 200, { ok: true });
    },
    "GET /history": ({ res, url }) => {
      const id = url.searchParams.get("chatId") ?? "";
      const before = asPositiveInt(url.searchParams.get("before"));
      const limit = asPositiveInt(url.searchParams.get("limit"));
      json(res, 200, {
        chatId: id,
        messages: h.history(id, { before, limit }),
      });
    },
    "GET /search": ({ res, url }) => {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json(res, 400, { ok: false, error: "q required" });
      const chatId = url.searchParams.get("chatId") ?? undefined;
      json(res, 200, { results: h.search(q, chatId) });
    },
    "POST /send": async ({ req, res }) => {
      const body = await readJson(req);
      const id = asString(body.chatId) ?? "";
      const text = asString(body.text) ?? "";
      const imagePath = asString(body.imagePath);
      const attachmentPath = asString(body.attachmentPath);
      // Text may be empty when an image is attached; require one or the
      // other.
      if (!id || (!text.trim() && !attachmentPath))
        return json(res, 400, {
          ok: false,
          error: "chatId and text (or an attachment) required",
        });
      h.send(id, text, { imagePath, attachmentPath });
      json(res, 202, { ok: true });
    },
    "POST /upload": async ({ req, res, url }) => {
      const filename = url.searchParams.get("filename") ?? "upload";
      const contentType =
        req.headers["content-type"] ?? "application/octet-stream";
      const bytes = await host.readRaw(req, MAX_UPLOAD_BYTES);
      if (!bytes.length)
        return json(res, 400, { ok: false, error: "Empty upload" });
      const result = await h.upload(filename, contentType, bytes);
      json(res, 200, { ok: true, ...result });
    },
    "GET /media": ({ res, url }) =>
      host.serveMedia(res, url.searchParams.get("id") ?? ""),
  };
}
