/**
 * Endpoint-mode version coupling — the machinery behind the pin.
 *
 * In endpoint mode the MCP child connects to a remote Playwright server
 * (the python-playwright process hosting Camoufox). Playwright's server
 * refuses the WebSocket upgrade with "428 Precondition Required" when the
 * client's playwright MINOR (sent in the User-Agent, `Playwright/x.y.z`)
 * differs from its own — so a client bump that nobody noticed turns every
 * browser tool call into an opaque error at the worst possible moment.
 *
 * Three guards, all keyed on ENDPOINT_PLAYWRIGHT_MINOR:
 *  - a unit test asserts the playwright-core that @playwright/mcp bundles is
 *    on that minor, so a dependency bump goes red in CI instead of green;
 *  - `validateConfig` refuses to start the plugin on a mismatch, with a
 *    message that names both versions and the fix;
 *  - `probeEndpoint` performs the real handshake at init and reports the
 *    server's verdict, so a drifted *server* is caught too.
 *
 * Bumping: change ENDPOINT_PLAYWRIGHT_MINOR and `@playwright/mcp` in
 * package.json in the same commit, after upgrading the python side
 * (camoufox caps python-playwright, so the node side cannot chase latest).
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

/**
 * Playwright minor of the remote endpoint (python playwright behind
 * Camoufox). Must equal the minor of the playwright-core bundled by the
 * pinned @playwright/mcp — see the header comment before changing it.
 */
export const ENDPOINT_PLAYWRIGHT_MINOR = "1.58";

/** "1.58.0-alpha-2026-01-16" → "1.58". */
export function minorOf(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : version;
}

function defaultModulesRoot(): string {
  return resolve(import.meta.dirname ?? ".", "../../../node_modules");
}

/** Version of the playwright-core the MCP child will run with. */
export function bundledPlaywrightVersion(
  modulesRoot: string = defaultModulesRoot(),
): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(
        resolve(modulesRoot, "playwright-core/package.json"),
        "utf-8",
      ),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/**
 * Static check: does the bundled client sit on the endpoint's minor?
 * Returns an error message, or undefined when coupled (or when the bundle
 * cannot be read — that is reported separately as a missing install).
 */
export function couplingError(
  bundled: string | undefined,
  expectedMinor: string = ENDPOINT_PLAYWRIGHT_MINOR,
): string | undefined {
  if (!bundled) return undefined;
  const got = minorOf(bundled);
  if (got === expectedMinor) return undefined;
  return (
    `@playwright/mcp bundles playwright-core ${bundled} (minor ${got}) but the ` +
    `remote endpoint is on Playwright ${expectedMinor} — every browser tool call ` +
    `would fail with "428 Precondition Required". Pin @playwright/mcp to the ` +
    `release that bundles playwright-core ${expectedMinor}.x, or bump ` +
    `ENDPOINT_PLAYWRIGHT_MINOR together with the python side ` +
    `(src/plugins/playwright/version-coupling.ts).`
  );
}

export type EndpointProbe =
  | { state: "match"; client: string }
  | { state: "mismatch"; client: string; server: string }
  | { state: "unreachable"; client: string; reason: string };

/** Parse the body Playwright's server sends with its 428. */
export function parseMismatch(
  body: string,
): { server: string; client: string } | undefined {
  const server = body.match(/server version:\s*v?([\d.]+)/);
  const client = body.match(/client version:\s*v?([\d.]+)/);
  return server && client
    ? { server: server[1], client: client[1] }
    : undefined;
}

/**
 * Perform the WebSocket upgrade the MCP child performs, advertising
 * `clientVersion`, and read the server's verdict. Never throws; never
 * leaves a connection open (a completed upgrade is torn down at once, and
 * Playwright's server treats that as an ordinary client disconnect).
 */
export function probeEndpoint(
  endpoint: string,
  clientVersion: string,
  timeoutMs = 3000,
): Promise<EndpointProbe> {
  return new Promise((settle) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      settle({
        state: "unreachable",
        client: clientVersion,
        reason: `invalid endpoint URL: ${endpoint}`,
      });
      return;
    }
    const secure = url.protocol === "wss:" || url.protocol === "https:";
    const request = secure ? httpsRequest : httpRequest;
    const req = request({
      host: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "User-Agent": `Playwright/${clientVersion} (talon endpoint probe)`,
      },
      timeout: timeoutMs,
    });
    let settled = false;
    const done = (result: EndpointProbe) => {
      if (settled) return;
      settled = true;
      req.destroy();
      settle(result);
    };
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      done({ state: "match", client: clientVersion });
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 428) {
          const parsed = parseMismatch(body);
          done(
            parsed
              ? {
                  state: "mismatch",
                  client: clientVersion,
                  server: parsed.server,
                }
              : {
                  state: "unreachable",
                  client: clientVersion,
                  reason: "428 without a version box in the body",
                },
          );
          return;
        }
        done({
          state: "unreachable",
          client: clientVersion,
          reason: `HTTP ${res.statusCode ?? "?"} instead of an upgrade`,
        });
      });
    });
    req.on("timeout", () =>
      done({ state: "unreachable", client: clientVersion, reason: "timeout" }),
    );
    req.on("error", (err: Error) =>
      done({
        state: "unreachable",
        client: clientVersion,
        reason: err.message,
      }),
    );
    req.end();
  });
}
