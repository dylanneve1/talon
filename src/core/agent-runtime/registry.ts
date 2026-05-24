/**
 * `BackendRegistry` shim — read the existing legacy backend registry
 * (`src/backend/registry.ts`) and expose every registered factory as
 * a `Backend` composed object via `adaptQueryBackend`.
 *
 * Why this lives in `agent-runtime/` instead of extending the
 * existing registry:
 *
 *   - The legacy registry stores `BackendFactory` records — each
 *     factory's `init()` returns a `QueryBackend` instance.
 *   - The new shape needs `Backend` objects (split capability
 *     interfaces). The shim adapts on demand without forcing every
 *     backend to grow a parallel native factory in this PR.
 *
 * Phase 1 / 2 contract: **no production caller invokes the shim
 * yet.** It exists so Phase 3+ work (dispatcher consuming
 * `AgentEvent`s, heartbeat / dream rendering from events) can swap
 * over without touching the legacy registry.
 *
 * Typical usage in a future migration:
 *
 *   const backends = await getAdaptedBackends(config, ctx);
 *   const claude   = backends.find((b) => b.id === "claude");
 *   for await (const event of claude!.chat!.runChatTurn(params)) {
 *     renderEvent(event);
 *   }
 *
 * The shim eagerly initialises every registered factory so the
 * caller can immediately iterate. For lazy single-factory init
 * (e.g. the dispatcher only ever talks to one backend per chat),
 * use `adaptOneBackend` below.
 */

import {
  getBackend as getLegacyFactory,
  listBackends as listLegacyFactories,
  type BackendInitContext,
  type BackendInstance,
} from "../../backend/registry.js";
import type { TalonConfig } from "../../util/config.js";
import { adaptQueryBackend, type AdapterOptions } from "./adapter.js";
import type { Backend } from "./capabilities.js";
import { isBackendId, type BackendId } from "./model-ref.js";

/**
 * Adapt every registered legacy backend factory into a `Backend`.
 * Each factory is `init`-ed exactly once; the returned array is
 * fresh on every call but the underlying `QueryBackend`s are
 * stable.
 *
 * Factories whose id is not in `BACKEND_IDS` are skipped with a
 * console warning — the typed `BackendId` union is the source of
 * truth for what the runtime can route to.
 */
export async function getAdaptedBackends(
  config: TalonConfig,
  ctx: BackendInitContext,
  options: AdapterOptions = {},
): Promise<Backend[]> {
  const out: Backend[] = [];
  for (const factory of listLegacyFactories()) {
    if (!isBackendId(factory.id)) {
      console.warn(
        `[agent-runtime/registry] Skipping backend "${factory.id}" — not in ` +
          `BACKEND_IDS literal. Update src/core/agent-runtime/model-ref.ts.`,
      );
      continue;
    }
    const instance: BackendInstance = await factory.init(config, ctx);
    out.push(
      adaptQueryBackend(instance.backend, factory.id, factory.label, options),
    );
  }
  return out;
}

/**
 * Adapt a single registered backend by id. Initialises the factory
 * and wraps the resulting `QueryBackend`. Returns `null` if no
 * factory with that id is registered (or if it's not in
 * `BACKEND_IDS`).
 *
 * Use this when only one backend is needed (the chat-role default,
 * or the explicit per-chat backend). Cheaper than calling
 * `getAdaptedBackends` and filtering.
 */
export async function adaptOneBackend(
  id: BackendId,
  config: TalonConfig,
  ctx: BackendInitContext,
  options: AdapterOptions = {},
): Promise<Backend | null> {
  if (!isBackendId(id)) return null;
  const factory = getLegacyFactory(id);
  if (!factory) return null;
  const instance: BackendInstance = await factory.init(config, ctx);
  return adaptQueryBackend(
    instance.backend,
    factory.id as BackendId,
    factory.label,
    options,
  );
}

/**
 * Adapt an already-instantiated `QueryBackend` into a `Backend`.
 *
 * The most common Phase 3+ migration shape: bootstrap initialises
 * the backend pool the legacy way, then a consumer asks for the
 * adapted view of one specific backend. Saves a re-init call.
 */
export function adaptInstantiatedBackend(
  instance: BackendInstance,
  id: BackendId,
  label: string,
  options: AdapterOptions = {},
): Backend {
  return adaptQueryBackend(instance.backend, id, label, options);
}
