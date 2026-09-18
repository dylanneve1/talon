import type { RouteHost } from "./host.js";
import type { BridgeRoutes } from "./table.js";
import { asPositiveInt } from "./params.js";

export function memoryRoutes(
  host: RouteHost,
): Pick<BridgeRoutes, "GET /memory" | "GET /memory/why"> {
  const { json, handlers: h } = host;
  return {
    // ── Memory (read-only) ─────────────────────────────────────────────

    // `q` turns the listing into a search; `kind` narrows either. A bad
    // kind is a 400 naming the valid ones, not an empty list — a typo
    // must not look like an empty memory.
    "GET /memory": ({ res, url }) => {
      const result = h.listMemory({
        q: url.searchParams.get("q") ?? undefined,
        kind: url.searchParams.get("kind") ?? undefined,
        limit: asPositiveInt(url.searchParams.get("limit")),
      });
      return result.ok
        ? json(res, 200, { rows: result.rows })
        : json(res, 400, { ok: false, error: result.error });
    },
    "GET /memory/why": ({ res, url }) => {
      const raw = url.searchParams.get("id") ?? "";
      const id = asPositiveInt(raw);
      const why = id === undefined ? null : h.memoryWhy(id);
      return why
        ? json(res, 200, why)
        : json(res, 404, { ok: false, error: `No memory with id ${raw}` });
    },
  };
}
