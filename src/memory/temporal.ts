/**
 * Temporal KG wrapper — preserves history when updating knowledge-graph facts.
 *
 * Problem:  `mempalace_kg_invalidate` + `mempalace_kg_add` silently discards the
 *           previous value. Over time this loses the evolution of facts like
 *           "what model was the heartbeat running in May?" or "when did Marrow
 *           reach v1.0?".
 *
 * Solution: Before invalidating, read the current value and archive it to a
 *           history drawer in the subject's palace room.  The new triple is then
 *           added with the standard invalidate-and-replace pattern.
 *
 * Architecture note: MemPalace is currently an MCP server — all operations go
 * through tool calls made by the LLM agent.  This module defines a typed
 * interface (`KgClient` / `PalaceClient`) so the logic can be:
 *
 *   1. Unit-tested with mocks (no live MCP needed).
 *   2. Wired to the real MCP server in Phase B once a direct TypeScript call
 *      surface exists (e.g. an in-process MCP client or a palace adapter).
 *   3. Used by heartbeat instances as a documented call pattern.
 *
 * See: docs/mempalace-temporal-profiles.md (hb #1018)
 *      AtomMem — arxiv:2606.19847
 */

// ── Interface contracts ───────────────────────────────────────────────────────

/**
 * A single knowledge-graph triple as returned by a query.
 *
 * These fields map directly to the MemPalace KG schema.
 */
export interface KgTriple {
  subject: string;
  predicate: string;
  object: string;
  /** ISO-8601 timestamp when the triple became valid. */
  valid_from?: string;
  /** ISO-8601 timestamp when the triple was invalidated; absent if still current. */
  valid_to?: string;
  /** True when the triple is the active / current value. */
  current?: boolean;
}

/**
 * Minimal interface for knowledge-graph operations.
 *
 * In production: wraps `mempalace_kg_query`, `mempalace_kg_invalidate`, and
 * `mempalace_kg_add` MCP tool calls.
 * In tests: an object implementing this interface with jest/vitest spies.
 */
export interface KgClient {
  /**
   * Return the active (current) triple for this (subject, predicate) pair,
   * or `undefined` if no current triple exists.
   */
  query(subject: string, predicate: string): Promise<KgTriple | undefined>;

  /**
   * Mark the active triple for this (subject, predicate) pair as no longer
   * current (set valid_to = now).  No-op if no active triple exists.
   */
  invalidate(subject: string, predicate: string): Promise<void>;

  /**
   * Create a new active triple with the given value.
   */
  add(
    subject: string,
    predicate: string,
    object: string,
    validFrom?: string,
  ): Promise<void>;
}

/**
 * Minimal interface for appending content to a palace drawer.
 *
 * In production: wraps `mempalace_add_drawer` or `mempalace_update_drawer`.
 * In tests: a simple spy.
 */
export interface PalaceClient {
  /**
   * Append `content` to the named drawer in `room`.
   * If the drawer does not exist it should be created.
   *
   * @param room     Palace wing + room path, e.g. `"projects/marrow"`.
   * @param label    Drawer label, e.g. `"marrow/version-history"`.
   * @param content  Markdown or plain text to append.
   */
  appendToHistoryDrawer(
    room: string,
    label: string,
    content: string,
  ): Promise<void>;
}

// ── Core function ─────────────────────────────────────────────────────────────

export interface UpdateKgFactOptions {
  /** KG client (required). */
  kgClient: KgClient;
  /**
   * Palace client for history archiving (optional).
   * When omitted the old value is silently dropped — same behaviour as the
   * raw invalidate+add pattern.
   */
  palaceClient?: PalaceClient;
  /**
   * Palace room to write the history drawer into, e.g. `"projects/marrow"`.
   * Required when `palaceClient` is provided; ignored otherwise.
   */
  historyRoom?: string;
  /**
   * Explicit ISO-8601 timestamp to use as `valid_from` for the new triple
   * and as the transition timestamp in the history entry.
   * Defaults to `new Date().toISOString()`.
   */
  timestamp?: string;
}

/**
 * Atomically update a KG fact while preserving its history.
 *
 * Steps:
 *  1. Query the current value.
 *  2. If a palace client + room are provided, archive the old value with its
 *     validity window to a history drawer.
 *  3. Invalidate the old triple.
 *  4. Add the new triple.
 *
 * If `newObject` equals the current value the function returns early without
 * making any changes — this prevents spurious history entries on no-op updates.
 *
 * @example
 * ```ts
 * await updateKgFact("marrow", "current_release", "v1.8.0", {
 *   kgClient,
 *   palaceClient,
 *   historyRoom: "projects/marrow",
 * });
 * ```
 */
export async function updateKgFact(
  subject: string,
  predicate: string,
  newObject: string,
  options: UpdateKgFactOptions,
): Promise<void> {
  const { kgClient, palaceClient, historyRoom } = options;
  const now = options.timestamp ?? new Date().toISOString();

  // 1. Read current value
  const current = await kgClient.query(subject, predicate);

  // 2. Early-exit on no-op
  if (current?.object === newObject) {
    return;
  }

  // 3. Archive old value to history drawer
  if (current?.object != null && palaceClient != null && historyRoom != null) {
    const from = current.valid_from ?? "unknown";
    const historyEntry = formatHistoryEntry(
      subject,
      predicate,
      current.object,
      from,
      now,
    );
    const drawerLabel = `${subject}/${predicate}-history`;
    await palaceClient.appendToHistoryDrawer(historyRoom, drawerLabel, historyEntry);
  }

  // 4. Invalidate old triple (if any)
  if (current != null) {
    await kgClient.invalidate(subject, predicate);
  }

  // 5. Add new triple
  await kgClient.add(subject, predicate, newObject, now);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Format a single temporal history entry as a Markdown bullet.
 *
 * Example output:
 *   `- [2026-06-01 → 2026-06-22] v1.6.0`
 */
export function formatHistoryEntry(
  subject: string,
  predicate: string,
  oldObject: string,
  validFrom: string,
  validTo: string,
): string {
  const from = validFrom.slice(0, 10); // YYYY-MM-DD
  const to = validTo.slice(0, 10);
  return `- [${from} → ${to}] ${subject}/${predicate}: ${oldObject}`;
}
