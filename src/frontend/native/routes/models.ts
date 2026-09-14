import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { asString } from "./params.js";

export function modelRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "GET /models"
  | "POST /model"
  | "GET /backends"
  | "POST /backend"
  | "GET /effort"
  | "POST /effort"
> {
  const { json, readJson, handlers: h } = host;
  return {
    // ── Models / backends / effort ─────────────────────────────────────

    "GET /models": async ({ res, url }) => {
      const id = url.searchParams.get("chatId") ?? undefined;
      json(res, 200, await h.listModels(id));
    },
    "POST /model": async ({ req, res }) => {
      const body = await readJson(req);
      h.setModel(asString(body.chatId) ?? "", asString(body.model) ?? "");
      json(res, 200, { ok: true });
    },
    "GET /backends": ({ res, url }) =>
      json(res, 200, h.listBackends(url.searchParams.get("chatId") ?? "")),
    "POST /backend": async ({ req, res }) => {
      const body = await readJson(req);
      // Always 200: ok/error is an application result the client renders,
      // not an HTTP-level failure (the client's decoder drops >=400
      // bodies).
      const result = await h.setBackend(
        asString(body.chatId) ?? "",
        asString(body.backend) ?? "",
      );
      json(res, 200, result);
    },
    "GET /effort": async ({ res, url }) =>
      json(
        res,
        200,
        await h.effortLevels(url.searchParams.get("chatId") ?? ""),
      ),
    "POST /effort": async ({ req, res }) => {
      const body = await readJson(req);
      h.setEffort(asString(body.chatId) ?? "", asString(body.effort) ?? "");
      json(res, 200, { ok: true });
    },
  };
}
