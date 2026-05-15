/**
 * Shared provider-resolution helpers for the remote-server backend family.
 *
 * Both OpenCode and Kilo expose the same `/provider` HTTP endpoint
 * returning a record of provider buckets, where each bucket lists
 * providers and their model catalogs. Talon stores model selections as
 * a single model id (so the user can write `claude-opus-4.7` without
 * knowing which auth bucket the upstream serves it from), so the shared
 * resolver walks every bucket looking for a provider that claims the
 * model — and picks the best match using a bucket-priority + name-prefix
 * heuristic.
 *
 * The bucket-priority / name-prefix heuristic itself is backend-specific
 * (Kilo's catalog uses different bucket names than OpenCode's), so this
 * module takes the heuristic as an injected callback rather than
 * hardcoding it.
 */

import { logWarn } from "../../util/log.js";
import type { RemoteAgentClient } from "./client.js";
import type { RemoteServerState } from "./state.js";

/**
 * Heuristic functions injected by the concrete backend.
 *
 * Both OpenCode and Kilo expose a richer set of these in their `models.ts`
 * — name-mapping, fuzzy-search, etc. The resolver here only needs the
 * two that affect provider scoring.
 */
export interface ProviderResolverHooks {
  /**
   * Best-guess provider id for a given model id, based on the model id
   * itself (e.g. `claude-` → `anthropic`). Used to break ties when
   * multiple buckets claim the same model id.
   */
  guessProviderID: (modelID: string) => string;
  /**
   * Numeric priority for a bucket name (lower = preferred). Used to
   * order otherwise-equal matches (e.g. preferring a built-in bucket
   * over a community / experimental one).
   */
  getBucketPriority: (bucketName: string) => number;
}

/**
 * Resolve a model id to its provider id by querying the upstream
 * provider list.
 *
 * The upstream prompt payload requires `model.providerID` — Talon stores
 * the model id alone so the user can write `claude-opus-4.7` without
 * knowing which auth bucket Kilo / OpenCode serves it from. This helper
 * walks every provider bucket, finds buckets that advertise this model
 * id, and picks the best match using the injected hooks' bucket-priority
 * + the heuristic guess.
 *
 * Falls back to `hooks.guessProviderID` if no provider bucket claims the
 * model — useful for hand-typed model ids that don't appear in the
 * catalog at all (provider will reject them, but with a clearer error).
 *
 * Result is cached in `state.modelProviderCache` so subsequent turns of
 * the same chat avoid the provider-list round-trip.
 */
export async function resolveProviderID<TClient extends RemoteAgentClient>(
  client: TClient,
  state: RemoteServerState<TClient>,
  modelID: string,
  hooks: ProviderResolverHooks,
): Promise<string> {
  const cachedProviderID = state.modelProviderCache.get(modelID);
  if (cachedProviderID) return cachedProviderID;

  const providerResp = await client.provider.list();
  const providerBuckets =
    (providerResp.data as Record<string, unknown> | undefined) ?? {};
  const guessedProviderID = hooks.guessProviderID(modelID);
  const matches: Array<{ providerID: string; bucketName: string }> = [];

  for (const [bucketName, bucket] of Object.entries(providerBuckets)) {
    if (!Array.isArray(bucket)) continue;

    for (const provider of bucket) {
      if (!provider || typeof provider !== "object") continue;

      const providerData = provider as {
        id?: string;
        models?: Record<string, { providerID?: string }>;
      };

      const modelEntry = providerData.models?.[modelID];
      if (!modelEntry) continue;

      const providerID = modelEntry.providerID ?? providerData.id;
      if (!providerID) continue;

      matches.push({ providerID, bucketName });
    }
  }

  if (matches.length > 0) {
    const score = (m: (typeof matches)[0]): number =>
      (m.providerID === guessedProviderID ? 0 : 2) +
      (m.providerID === "opencode" ? 0 : 1) +
      hooks.getBucketPriority(m.bucketName) * 0.1;
    matches.sort((a, b) => score(a) - score(b));

    const resolvedProviderID = matches[0].providerID;
    state.modelProviderCache.set(modelID, resolvedProviderID);
    return resolvedProviderID;
  }

  const fallbackProviderID = hooks.guessProviderID(modelID);
  state.modelProviderCache.set(modelID, fallbackProviderID);
  logWarn(
    "agent",
    `Could not resolve provider for model ${modelID}; falling back to ${fallbackProviderID}`,
  );
  return fallbackProviderID;
}
