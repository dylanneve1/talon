/**
 * Typed memory store — one row per claim, with FTS5 retrieval and a
 * full audit trail (docs/memory-persona-plan.md §3.1–3.3).
 *
 * Three ideas shape the API:
 *
 *   - **Kinds are lifecycles, not labels.** `directive` is durable human
 *     intent, `fact` is durable and supersedable, `state` is keyed,
 *     `episode` decays fast, `relationship` / `reflection` are the
 *     persona layer.
 *   - **Keyed state replaces.** `replaceStateKey("heartbeat.health", …)`
 *     supersedes the live row for that key instead of appending another
 *     dated section — the fix for accretion.
 *   - **Nothing is deleted.** A superseded row keeps its id and points at
 *     its replacement; a dropped row keeps its id and gets a
 *     `dropped_at` stamp (the graveyard). Both stay readable by id, so
 *     every change is diffable and revertible, and every mutation writes
 *     a `memory_history` row.
 *
 * SQLite-backed (see repositories/memory-repo.ts for the statements;
 * this module holds the domain API, validation and the transactional
 * lifecycle rules — no SQL here). Every write runs inside
 * `inTransaction`, so a row and its audit entry land together or not
 * at all.
 */

import { ftsQuote } from "../native/sqlguard.js";
import { inTransaction } from "./db.js";
import * as repo from "./repositories/memory-repo.js";

export type {
  MemoryHistoryRow,
  MemoryInput,
  MemoryKind,
  MemoryRow,
  MemorySource,
  MemoryTrust,
} from "./repositories/memory-repo.js";
import type {
  MemoryHistoryRow,
  MemoryInput,
  MemoryKind,
  MemoryOp,
  MemoryRow,
  MemorySource,
  MemoryTrust,
} from "./repositories/memory-repo.js";

export const MEMORY_KINDS: readonly MemoryKind[] = [
  "directive",
  "fact",
  "state",
  "episode",
  "relationship",
  "reflection",
];

const MEMORY_TRUSTS: readonly MemoryTrust[] = [
  "operator",
  "agent",
  "user_claim",
  "group_chat",
];

/**
 * Trust tiers that can never be pinned: a claim someone made about
 * themselves, or something overheard in a group, must not be promoted
 * to the never-truncated tier (plan §5).
 */
const UNPINNABLE_TRUSTS: readonly MemoryTrust[] = ["user_claim", "group_chat"];

export const MAX_TEXT_LENGTH = 4_000;
export const MAX_SUBJECT_LENGTH = 200;
const MAX_KEY_LENGTH = 100;
const KEY_PATTERN = /^[a-z0-9_.-]+$/;

/** How many near-duplicate candidates an assert reports back. */
const SIMILAR_LIMIT = 5;

/** How many terms of a new claim are probed against the existing rows. */
const SIMILAR_TERM_LIMIT = 24;

const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;

// ── Validation ──────────────────────────────────────────────────────────────

export function isMemoryKind(value: unknown): value is MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind);
}

function isMemoryTrust(value: unknown): value is MemoryTrust {
  return MEMORY_TRUSTS.includes(value as MemoryTrust);
}

/** Validate and trim a claim's text — the same rule for every write path. */
function validateText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Memory text must not be empty");
  if (trimmed.length > MAX_TEXT_LENGTH)
    throw new Error(`Memory text too long (max ${MAX_TEXT_LENGTH} chars)`);
  return trimmed;
}

function validateSubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) throw new Error("Memory subject must not be empty");
  if (trimmed.length > MAX_SUBJECT_LENGTH)
    throw new Error(
      `Memory subject too long (max ${MAX_SUBJECT_LENGTH} chars)`,
    );
  return trimmed;
}

/** Keys are the state namespace: lowercase, dotted, no spaces. */
function validateStateKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("State memory requires a key");
  if (trimmed.length > MAX_KEY_LENGTH)
    throw new Error(`Memory key too long (max ${MAX_KEY_LENGTH} chars)`);
  if (!KEY_PATTERN.test(trimmed))
    throw new Error(
      `Invalid memory key "${trimmed}" (allowed: lowercase letters, digits, . _ -)`,
    );
  return trimmed;
}

/** Normalize a caller's input into the exact row the repository inserts. */
function normalize(input: MemoryInput): repo.MemoryInsert {
  if (!isMemoryKind(input.kind))
    throw new Error(
      `Unknown memory kind "${String(input.kind)}" (expected one of ${MEMORY_KINDS.join(", ")})`,
    );
  if (!isMemoryTrust(input.trust))
    throw new Error(
      `Unknown memory trust "${String(input.trust)}" (expected one of ${MEMORY_TRUSTS.join(", ")})`,
    );
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new Error(
      `Memory confidence must be between 0 and 1 (got ${confidence})`,
    );
  if (input.kind !== "state" && input.key !== undefined)
    throw new Error(`Only state memories carry a key (kind=${input.kind})`);
  const key =
    input.kind === "state" ? validateStateKey(input.key ?? "") : undefined;
  const subject = validateSubject(input.subject);
  const text = validateText(input.text);
  if (input.pinned && UNPINNABLE_TRUSTS.includes(input.trust))
    throw new Error(`A ${input.trust} memory can never be pinned`);
  const now = Date.now();
  return {
    kind: input.kind,
    subject,
    ...(key !== undefined ? { key } : {}),
    text,
    source: input.source ?? {},
    trust: input.trust,
    confidence,
    createdAt: now,
    lastSeenAt: now,
    hitCount: 0,
    salience: input.salience ?? 0,
    pinned: input.pinned ?? false,
    contentHash: repo.contentHash(input.kind, subject, key, text),
  };
}

// ── Internals ───────────────────────────────────────────────────────────────

/** Insert a normalized row and open its audit trail with one entry. */
function insertWithHistory(
  row: repo.MemoryInsert,
  op: MemoryOp,
  reason?: string,
): number {
  const id = repo.insert(row);
  repo.insertHistory({
    memoryId: id,
    op,
    afterText: row.text,
    ...(reason ? { reason } : {}),
    at: row.createdAt,
  });
  return id;
}

/**
 * The FTS5 expression that finds near-duplicates of a new claim.
 *
 * A restatement is rarely word-for-word, so the terms are OR-ed rather
 * than AND-ed (which is what a plain `ftsQuote` of the whole text would
 * give) and bm25 does the ranking. Every term still goes through the
 * shared `ftsQuote` core, so nothing in the text is parsed as syntax.
 * Short words carry no signal and the tail of a long claim adds none,
 * so both are dropped.
 */
function similarityQuery(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 2)
    .slice(0, SIMILAR_TERM_LIMIT)
    .map((term) => ftsQuote(term))
    .filter(Boolean)
    .join(" OR ");
}

/**
 * Load a row that a mutation is about to change, or explain why it
 * can't. Only a live row is mutable: a dropped one is in the graveyard
 * and a superseded one has a successor, so editing it would fork the
 * chain that `/memory diff` and `/memory undo` walk. Always called
 * inside the mutation's own transaction — read-then-write is one unit.
 */
function requireLive(id: number, what: string): MemoryRow {
  const row = repo.get(id);
  if (!row) throw new Error(`No memory with id ${id}`);
  if (row.droppedAt !== undefined)
    throw new Error(`Memory ${id} is dropped; cannot ${what} it`);
  if (row.supersededBy !== undefined)
    throw new Error(
      `Memory ${id} is superseded by #${row.supersededBy}; cannot ${what} it`,
    );
  return row;
}

/** The row a supersede/merge/replace creates, inheriting the old row's frame. */
function successorOf(old: MemoryRow, text: string): repo.MemoryInsert {
  const now = Date.now();
  return {
    kind: old.kind,
    subject: old.subject,
    ...(old.key !== undefined ? { key: old.key } : {}),
    text,
    source: old.source,
    trust: old.trust,
    confidence: old.confidence,
    createdAt: now,
    lastSeenAt: now,
    hitCount: 0,
    salience: old.salience,
    pinned: old.pinned,
    contentHash: repo.contentHash(old.kind, old.subject, old.key, text),
  };
}

/** Point `oldId` at its replacement and record the supersede. */
function markSuperseded(
  old: MemoryRow,
  newId: number,
  text: string,
  reason: string | undefined,
): void {
  repo.setSupersededBy(old.id, newId);
  repo.insertHistory({
    memoryId: old.id,
    op: "supersede",
    beforeText: old.text,
    afterText: text,
    ...(reason ? { reason } : {}),
    at: Date.now(),
  });
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Record a new claim.
 *
 * Returns the new id together with the live near-duplicates of the same
 * kind + subject (best FTS matches first). Nothing is auto-superseded:
 * the caller decides whether this was a restatement worth folding into
 * the existing row — the "supersede instead of append" offer of plan §3.2.
 */
export function assertMemory(input: MemoryInput): {
  id: number;
  similar: MemoryRow[];
} {
  const row = normalize(input);
  return inTransaction(() => {
    const id = insertWithHistory(row, "assert");
    const match = similarityQuery(row.text);
    const similar = match
      ? repo.similar(match, row.kind, row.subject, id, SIMILAR_LIMIT)
      : [];
    return { id, similar };
  });
}

/**
 * Replace a claim's text. The new row inherits the old row's frame
 * (kind, subject, key, source, trust, confidence, salience, pinned) and
 * the old row stays readable, pointing at its replacement.
 */
export function supersedeMemory(
  id: number,
  text: string,
  reason?: string,
): number {
  const valid = validateText(text);
  return inTransaction(() => {
    const old = requireLive(id, "supersede");
    const next = successorOf(old, valid);
    const newId = insertWithHistory(next, "assert", reason);
    markSuperseded(old, newId, next.text, reason);
    return newId;
  });
}

/**
 * Send a row to the graveyard: a soft delete that keeps the id, the
 * text and the audit trail. Pinned rows need an explicit reason — the
 * one guard against a bad reconcile turn dropping human intent.
 */
export function dropMemory(id: number, reason?: string): void {
  const why = reason?.trim();
  inTransaction(() => {
    const row = requireLive(id, "drop");
    if (row.pinned && !why)
      throw new Error(`Memory ${id} is pinned; dropping it requires a reason`);
    const at = Date.now();
    repo.setDropped(id, at);
    repo.insertHistory({
      memoryId: id,
      op: "drop",
      beforeText: row.text,
      ...(why ? { reason: why } : {}),
      at,
    });
  });
}

/**
 * Fold several rows of the same kind into one. The survivor inherits
 * the first id's frame; every input row is superseded by it.
 */
export function mergeMemory(
  ids: readonly number[],
  text: string,
  reason?: string,
): number {
  if (ids.length === 0) throw new Error("Merge needs at least one memory id");
  const valid = validateText(text);
  return inTransaction(() => {
    const rows = ids.map((id) => requireLive(id, "merge"));
    const first = rows[0]!;
    const odd = rows.find((row) => row.kind !== first.kind);
    if (odd)
      throw new Error(
        `Cannot merge across kinds (${first.kind} vs ${odd.kind} at id ${odd.id})`,
      );
    const next = successorOf(first, valid);
    const newId = insertWithHistory(next, "merge", reason);
    for (const row of rows) markSuperseded(row, newId, next.text, reason);
    return newId;
  });
}

/** Promote a row to the never-truncated tier. */
export function pinMemory(id: number): void {
  setPinned(id, true, "pin");
}

/** Return a pinned row to the ranked pool. */
export function unpinMemory(id: number): void {
  setPinned(id, false, "unpin");
}

function setPinned(id: number, pinned: boolean, op: MemoryOp): void {
  inTransaction(() => {
    const row = requireLive(id, op);
    if (pinned && UNPINNABLE_TRUSTS.includes(row.trust))
      throw new Error(`A ${row.trust} memory can never be pinned`);
    repo.setPinned(row.id, pinned);
    repo.insertHistory({
      memoryId: row.id,
      op,
      beforeText: row.text,
      afterText: row.text,
      at: Date.now(),
    });
  });
}

/** Options for `replaceStateKey` — everything has a sensible default. */
export type ReplaceStateOptions = {
  /** Defaults to the key's prefix before the first dot. */
  subject?: string;
  trust?: MemoryTrust;
  confidence?: number;
  salience?: number;
  reason?: string;
};

/**
 * The keyed-state rule: a write REPLACES the row for that key. The
 * previous live row (if any) is superseded in the same transaction, so
 * `heartbeat.health` is one row overwritten rather than a new dated
 * section per run. Returns the new row's id.
 */
export function replaceStateKey(
  key: string,
  text: string,
  source: MemorySource = {},
  opts: ReplaceStateOptions = {},
): number {
  const validKey = validateStateKey(key);
  const row = normalize({
    kind: "state",
    subject: opts.subject ?? validKey.split(".")[0]!,
    key: validKey,
    text,
    source,
    trust: opts.trust ?? "agent",
    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
    ...(opts.salience !== undefined ? { salience: opts.salience } : {}),
  });
  return inTransaction(() => {
    const previous = repo.liveStateByKey(validKey);
    const id = insertWithHistory(row, "replace_state", opts.reason);
    if (previous) markSuperseded(previous, id, row.text, opts.reason);
    return id;
  });
}

/**
 * Record a retrieval hit: one more use, seen just now.
 *
 * Deliberately writes no `memory_history` row — a touch changes no
 * content, and the retriever calls it per hit, so auditing it would
 * bury the entries that describe real changes.
 */
export function touchMemory(id: number): void {
  inTransaction(() => {
    const row = requireLive(id, "touch");
    repo.touch(row.id, Date.now());
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Any row by id — including superseded and dropped ones. */
export function getMemory(id: number): MemoryRow | undefined {
  return repo.get(id);
}

/** Filters for `listMemories`; live rows only unless asked otherwise. */
export type MemoryListOptions = {
  kind?: MemoryKind;
  subject?: string;
  includeSuperseded?: boolean;
  includeDropped?: boolean;
  limit?: number;
};

/** Ranked listing: pinned first, then salience, then recency. */
export function listMemories(opts: MemoryListOptions = {}): MemoryRow[] {
  return repo.list({
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    ...(opts.includeSuperseded ? { includeSuperseded: true } : {}),
    ...(opts.includeDropped ? { includeDropped: true } : {}),
    limit: opts.limit ?? DEFAULT_LIST_LIMIT,
  });
}

/**
 * Full-text search over live rows, best match first (bm25). Free-form
 * input is quoted into a literal FTS5 expression by the shared
 * `ftsQuote` core, so operators and punctuation in a query are matched
 * as text rather than parsed as syntax.
 */
export function searchMemories(
  query: string,
  opts: { kind?: MemoryKind; limit?: number } = {},
): MemoryRow[] {
  const match = ftsQuote(query);
  if (!match) return [];
  return repo.searchFts(match, opts.kind, opts.limit ?? DEFAULT_SEARCH_LIMIT);
}

/** The audit trail for one row, oldest entry first. */
export function memoryHistory(id: number): MemoryHistoryRow[] {
  return repo.historyFor(id);
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * One row as a single line — shared by the CLI and (from PR 5) the
 * `/memory` command, so both surfaces describe a memory identically.
 */
export function formatMemory(row: MemoryRow): string {
  const markers = [
    row.pinned ? "pinned" : "",
    row.supersededBy !== undefined ? `superseded by #${row.supersededBy}` : "",
    row.droppedAt !== undefined ? "dropped" : "",
  ].filter(Boolean);
  const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
  // A state row's key is the more specific label, and carries its
  // subject as the prefix anyway (heartbeat.health → heartbeat).
  const label = row.key ?? row.subject;
  return `#${row.id} [${row.kind}] ${label}: ${row.text}${suffix}`;
}
