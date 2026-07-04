/**
 * Memory pre-retrieval (Phase B) — injectable retriever boundary.
 *
 * Phase A made `memory.md` the compact always-loaded layer; Phase B closes the
 * recall gap by handing each chat turn a small, relevant palace slice without
 * depending on the model to call `mempalace_search` itself. This module owns
 * the CORE side of that boundary: a typed retriever dependency the Weaver can
 * call before `runChatTurn(...)`, returning plain data
 * (`RetrievedMemory | undefined`) that backends fold into the live user
 * prompt via `formatPromptWithRetrievedMemory`.
 *
 * Deliberate constraints (see docs/memory-phase-b-pre-retrieval.md):
 *
 *   - The retriever receives a small context object and returns plain data.
 *     It never imports backend handlers, and retrieval output never enters
 *     `prepareSystemPrompt()` / frozen prompt snapshots — cache safety first.
 *   - Fail closed: a broken retriever must never block chat delivery. The
 *     Weaver catches errors, logs one warning, and runs the turn without
 *     injected memory.
 *   - The PRODUCTION retriever is intentionally absent in this first pass.
 *     There is no clean in-process MemPalace call surface yet (the plugin is
 *     an MCP server, not a typed module), and shelling out per message from
 *     the dispatch hot path is explicitly forbidden. Until a deliberate
 *     bridge exists, deployments get `noopMemoryRetriever` — plumbing lands
 *     inert, prompts stay byte-identical.
 *   - Trust-aware injection (#373): when a real adapter lands, only items
 *     with `trustLevel` in `AUTO_INJECT_TRUST_LEVELS` may be auto-injected.
 *     `user_claim` / `group_chat` content stays pull-only, or a poisoned
 *     drawer becomes a persistent prompt injection in every session.
 */

import type {
  RetrievedMemory,
  RetrievedMemoryTrustLevel,
} from "../agent-runtime/capabilities.js";

// ── Retriever contract ──────────────────────────────────────────────────────

/** Context handed to a retriever for one chat turn. */
export type MemoryRetrievalContext = {
  runKind: "chat";
  chatId: string;
  /** The raw incoming message text (retrievers trim/cap it themselves). */
  text: string;
  senderName: string;
  isGroup?: boolean;
};

/**
 * A memory retriever: small context in, bounded plain data out.
 * `undefined` means "inject nothing" — the turn proceeds unchanged.
 */
export type MemoryRetriever = (
  context: MemoryRetrievalContext,
) => Promise<RetrievedMemory | undefined>;

// ── Trust policy (#373) ─────────────────────────────────────────────────────

/**
 * Trust levels eligible for automatic injection. Anything else (including an
 * absent `trustLevel`) must be filtered by adapters before returning items.
 */
export const AUTO_INJECT_TRUST_LEVELS: ReadonlySet<RetrievedMemoryTrustLevel> =
  new Set(["dylan_direct", "bot_inferred", "heartbeat_synthesis"]);

/** True when an item's trust level allows automatic injection. */
export function isAutoInjectTrusted(
  trustLevel: RetrievedMemoryTrustLevel | undefined,
): boolean {
  return trustLevel !== undefined && AUTO_INJECT_TRUST_LEVELS.has(trustLevel);
}

/**
 * Enforce the #373 trust policy on a retrieval result: drop every item that
 * is not explicitly auto-inject trusted. Adapters should call this as their
 * last step so the filter cannot be forgotten upstream of the prompt.
 */
export function filterAutoInjectable(
  memory: RetrievedMemory | undefined,
): RetrievedMemory | undefined {
  if (!memory) return undefined;
  const items = memory.items.filter((i) => isAutoInjectTrusted(i.trustLevel));
  if (items.length === 0) return undefined;
  return { ...memory, items };
}

// ── Default (inert) retriever ───────────────────────────────────────────────

/** The no-op retriever: Phase B plumbing present, injection disabled. */
export const noopMemoryRetriever: MemoryRetriever = async () => undefined;
