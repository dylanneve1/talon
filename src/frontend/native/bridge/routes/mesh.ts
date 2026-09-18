import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import type { ServerResponse } from "node:http";
import { deviceIdParam } from "./params.js";

// Streamed device file transfers (see core/mesh/transfers/transfers.ts). The
// one-time `transfer` token authorizes exactly one direction+path; the
// caller names itself so the token's device binding can be checked.
function transferToken(
  host: RouteHost,
  url: URL,
  res: ServerResponse,
): string | null {
  const token = url.searchParams.get("transfer") ?? "";
  if (!token) {
    host.json(res, 400, { ok: false, error: "transfer required" });
    return null;
  }
  return token;
}

export function meshRoutes(
  host: RouteHost,
): Pick<
  BridgeRoutes,
  | "POST /devices/register"
  | "POST /location"
  | "GET /devices"
  | "POST /devices/command-result"
  | "POST /devices/file"
  | "GET /devices/file"
> {
  const { json, readJson, handlers: h } = host;
  return {
    // ── Mesh ───────────────────────────────────────────────────────────

    "POST /devices/register": async ({ req, res }) => {
      const body = await readJson(req);
      const device = await h.registerDevice(body);
      json(res, 200, { ok: true, deviceId: device.id });
    },
    "POST /location": async ({ req, res }) => {
      const body = await readJson(req);
      await h.storeLocation(body);
      json(res, 200, { ok: true });
    },
    "GET /devices": async ({ res }) => json(res, 200, await h.listDevices()),
    "POST /devices/command-result": async ({ req, res }) => {
      const body = await readJson(req);
      // ok:false for a late/unknown correlation id — not an HTTP error,
      // the device's POST was well-formed; nothing was waiting anymore.
      json(res, 200, { ok: h.completeCommand(body) });
    },
    "POST /devices/file": async ({ req, res, url }) => {
      const token = transferToken(host, url, res);
      if (token === null) return;
      const result = await h.acceptFileUpload(token, req, deviceIdParam(url));
      json(res, result.ok ? 200 : 409, result);
    },
    "GET /devices/file": async ({ res, url }) => {
      const token = transferToken(host, url, res);
      if (token === null) return;
      const file = await h.openFileDownload(token, deviceIdParam(url));
      if (!file)
        return json(res, 404, {
          ok: false,
          error: "Unknown or already-used transfer token",
        });
      host.streamFile(res, file);
    },
  };
}
