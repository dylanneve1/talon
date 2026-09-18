import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { isLogLevel } from "../../protocol.js";
import { asPositiveInt, asString } from "./params.js";

export function daemonRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "GET /logs"
  | "GET /plugins"
  | "POST /plugins/toggle"
  | "GET /skills"
  | "POST /skills/toggle"
  | "GET /config"
  | "POST /config"
  | "POST /control"
> {
  const { json, readJson, handlers: h } = host;
  return {
    // ── Daemon ─────────────────────────────────────────────────────────

    "GET /logs": ({ res, url }) => {
      const lines = Math.min(
        asPositiveInt(url.searchParams.get("lines")) ?? 200,
        1000,
      );
      const level = url.searchParams.get("level") ?? "";
      const component = url.searchParams.get("component") ?? undefined;
      json(res, 200, {
        entries: h.logs({
          lines,
          minLevel: isLogLevel(level) ? level : undefined,
          component,
        }),
      });
    },
    "GET /plugins": ({ res }) => json(res, 200, { plugins: h.listPlugins() }),
    "POST /plugins/toggle": async ({ req, res }) => {
      const body = await readJson(req);
      // Always 200: ok/error is an application result the client renders
      // (mirrors /backend).
      const result = await h.setPluginEnabled(
        asString(body.name) ?? "",
        body.enabled === true,
      );
      json(res, 200, result);
    },
    "GET /skills": ({ res }) => json(res, 200, { skills: h.listSkills() }),
    "POST /skills/toggle": async ({ req, res }) => {
      const body = await readJson(req);
      json(
        res,
        200,
        h.setSkillEnabled(asString(body.name) ?? "", body.enabled === true),
      );
    },
    "GET /config": ({ res }) => json(res, 200, h.getConfig()),
    "POST /config": async ({ req, res }) => {
      const body = await readJson(req);
      json(res, 200, h.setConfig(body));
    },
    "POST /control": async ({ req, res }) => {
      const body = await readJson(req);
      // Always 200: ok/message is an application result the client
      // renders (mirrors /backend).
      json(res, 200, await h.control(asString(body.action) ?? ""));
    },
  };
}
