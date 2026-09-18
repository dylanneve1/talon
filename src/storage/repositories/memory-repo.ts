/**
 * Memory repository — executes the statements in sql/memory.sql against
 * the `memory` / `memory_fts` / `memory_history` tables; no SQL text
 * lives here. The public store (storage/memory.ts) holds the domain API,
 * validation and the transactional lifecycle rules; this module owns
 * statement execution, the row↔domain mapping and the content hash.
 */

import { createHash } from "node:crypto";
import { getDatabase } from "../db.js";
import { memorySql } from "../sql/statements.generated.js";

/** Kinds are lifecycles, not labels — see docs/memory-persona-plan.md §3.1. */
export type MemoryKind =
  "directive" | "fact" | "state" | "episode" | "relationship" | "reflection";

/** Where a claim came from, and therefore how far it is allowed to rise. */
export type MemoryTrust = "operator" | "agent" | "user_claim" | "group_chat";

/** The mutation vocabulary recorded in memory_history. */
export type MemoryOp =
  "assert" | "supersede" | "drop" | "merge" | "pin" | "unpin" | "replace_state";

/** Provenance of a claim: which frontend, chat, actor and turn asserted it. */
export type MemorySource = {
  frontend?: string;
  chat?: string;
  actor?: string;
  turn?: string;
};

/** One memory row as the domain sees it. */
export type MemoryRow = {
  id: number;
  kind: MemoryKind;
  subject: string;
  /** Present only for kind='state' — the key whose single live row this is. */
  key?: string;
  text: string;
  source: MemorySource;
  trust: MemoryTrust;
  /** 0..1. */
  confidence: number;
  createdAt: number;
  lastSeenAt: number;
  hitCount: number;
  salience: number;
  pinned: boolean;
  /** Id of the row that replaced this one; absent while live. */
  supersededBy?: number;
  /** When this row was dropped to the graveyard; absent while live. */
  droppedAt?: number;
  /** sha256 of kind|subject|key|text — the import idempotency key. */
  contentHash: string;
};

/** One audit entry. */
export type MemoryHistoryRow = {
  id: number;
  memoryId: number;
  op: MemoryOp;
  beforeText?: string;
  afterText?: string;
  reason?: string;
  at: number;
};

/** A new claim, as callers supply it (the store fills in the defaults). */
export type MemoryInput = {
  kind: MemoryKind;
  subject: string;
  key?: string;
  text: string;
  source?: MemorySource;
  trust: MemoryTrust;
  confidence?: number;
  salience?: number;
  pinned?: boolean;
};

/** The fully-defaulted row the repository inserts. */
export type MemoryInsert = Omit<MemoryRow, "id" | "supersededBy" | "droppedAt">;

/** Filters for `list`; everything is optional and narrows the result. */
export type MemoryListFilter = {
  kind?: MemoryKind;
  subject?: string;
  includeSuperseded?: boolean;
  includeDropped?: boolean;
  limit?: number;
};

type Row = {
  id: number;
  kind: string;
  subject: string;
  key: string | null;
  text: string;
  source_frontend: string | null;
  source_chat: string | null;
  source_actor: string | null;
  source_turn: string | null;
  trust: string;
  confidence: number;
  created_at: number;
  last_seen_at: number;
  hit_count: number;
  salience: number;
  pinned: number;
  superseded_by: number | null;
  dropped_at: number | null;
  content_hash: string;
};

type HistoryRow = {
  id: number;
  memory_id: number;
  op: string;
  before_text: string | null;
  after_text: string | null;
  reason: string | null;
  at: number;
};

function rowToMemory(row: Row): MemoryRow {
  const source: MemorySource = {
    ...(row.source_frontend !== null ? { frontend: row.source_frontend } : {}),
    ...(row.source_chat !== null ? { chat: row.source_chat } : {}),
    ...(row.source_actor !== null ? { actor: row.source_actor } : {}),
    ...(row.source_turn !== null ? { turn: row.source_turn } : {}),
  };
  return {
    id: Number(row.id),
    kind: row.kind as MemoryKind,
    subject: row.subject,
    ...(row.key !== null ? { key: row.key } : {}),
    text: row.text,
    source,
    trust: row.trust as MemoryTrust,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    hitCount: row.hit_count,
    salience: row.salience,
    pinned: row.pinned !== 0,
    ...(row.superseded_by !== null
      ? { supersededBy: Number(row.superseded_by) }
      : {}),
    ...(row.dropped_at !== null ? { droppedAt: row.dropped_at } : {}),
    contentHash: row.content_hash,
  };
}

function rowToHistory(row: HistoryRow): MemoryHistoryRow {
  return {
    id: Number(row.id),
    memoryId: Number(row.memory_id),
    op: row.op as MemoryOp,
    ...(row.before_text !== null ? { beforeText: row.before_text } : {}),
    ...(row.after_text !== null ? { afterText: row.after_text } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    at: row.at,
  };
}

/**
 * The idempotency key for PR 5's import: identical claims hash
 * identically regardless of provenance or ranking, so re-importing the
 * same `memory.md` produces no new rows.
 */
export function contentHash(
  kind: string,
  subject: string,
  key: string | undefined,
  text: string,
): string {
  return createHash("sha256")
    .update(`${kind}|${subject}|${key ?? ""}|${text}`)
    .digest("hex");
}

/** Insert a fully-defaulted row; returns the new id. */
export function insert(row: MemoryInsert): number {
  const inserted = getDatabase()
    .prepare(memorySql.insert)
    .get(
      row.kind,
      row.subject,
      row.key ?? null,
      row.text,
      row.source.frontend ?? null,
      row.source.chat ?? null,
      row.source.actor ?? null,
      row.source.turn ?? null,
      row.trust,
      row.confidence,
      row.createdAt,
      row.lastSeenAt,
      row.hitCount,
      row.salience,
      row.pinned ? 1 : 0,
      row.contentHash,
    ) as { id: number };
  return Number(inserted.id);
}

export function get(id: number): MemoryRow | undefined {
  const row = getDatabase().prepare(memorySql.get).get(id) as Row | undefined;
  return row ? rowToMemory(row) : undefined;
}

/** Filtered listing, pinned first then salience then recency. */
export function list(filter: MemoryListFilter = {}): MemoryRow[] {
  const kind = filter.kind ?? null;
  const subject = filter.subject ?? null;
  const rows = getDatabase()
    .prepare(memorySql.list)
    .all(
      kind,
      kind,
      subject,
      subject,
      filter.includeSuperseded ? 1 : 0,
      filter.includeDropped ? 1 : 0,
      filter.limit ?? 100,
    ) as Row[];
  return rows.map(rowToMemory);
}

/** The single live `state` row for a key, if there is one. */
export function liveStateByKey(key: string): MemoryRow | undefined {
  const row = getDatabase().prepare(memorySql.liveStateByKey).get(key) as
    Row | undefined;
  return row ? rowToMemory(row) : undefined;
}

/** FTS5 search over live rows, best match first. `match` must be quoted. */
export function searchFts(
  match: string,
  kind: MemoryKind | undefined,
  limit: number,
): MemoryRow[] {
  const k = kind ?? null;
  const rows = getDatabase()
    .prepare(memorySql.searchFts)
    .all(match, k, k, limit) as Row[];
  return rows.map(rowToMemory);
}

/** Near-duplicate candidates for a fresh assert. `match` must be quoted. */
export function similar(
  match: string,
  kind: MemoryKind,
  subject: string,
  excludeId: number,
  limit: number,
): MemoryRow[] {
  const rows = getDatabase()
    .prepare(memorySql.similar)
    .all(match, kind, subject, excludeId, limit) as Row[];
  return rows.map(rowToMemory);
}

export function setSupersededBy(id: number, newId: number): void {
  getDatabase().prepare(memorySql.setSupersededBy).run(newId, id);
}

export function setDropped(id: number, at: number): void {
  getDatabase().prepare(memorySql.setDropped).run(at, id);
}

export function setPinned(id: number, pinned: boolean): void {
  getDatabase()
    .prepare(memorySql.setPinned)
    .run(pinned ? 1 : 0, id);
}

export function touch(id: number, at: number): void {
  getDatabase().prepare(memorySql.touch).run(at, id);
}

/** Append one audit entry — every mutation writes exactly one. */
export function insertHistory(entry: {
  memoryId: number;
  op: MemoryOp;
  beforeText?: string;
  afterText?: string;
  reason?: string;
  at: number;
}): void {
  getDatabase()
    .prepare(memorySql.insertHistory)
    .run(
      entry.memoryId,
      entry.op,
      entry.beforeText ?? null,
      entry.afterText ?? null,
      entry.reason ?? null,
      entry.at,
    );
}

export function historyFor(id: number): MemoryHistoryRow[] {
  const rows = getDatabase()
    .prepare(memorySql.historyFor)
    .all(id) as HistoryRow[];
  return rows.map(rowToHistory);
}
