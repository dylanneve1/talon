/**
 * `memory.md` and the daily notes → typed memory rows.
 *
 * The store (storage/memory.ts) becomes the source of truth in PR 8, but
 * the markdown files hold years of the operator's own writing and stay
 * hand-editable afterwards. This module is the bridge: it seeds the store
 * from the files, and — because it is idempotent by content hash — it is
 * also how a hand-edit to the rendered `memory.md` folds back in
 * (plan §3.1, rollout PR 5).
 *
 * Three rules make re-running it safe:
 *
 *   - **The parser is PR 1's.** Sections, families and tiers come from
 *     prompt/memory-view.ts, so what the prompt considers one status
 *     family is what the store considers one keyed state row. Nothing is
 *     classified twice, two different ways.
 *   - **Content hash decides.** A live import-owned row with the same
 *     kind + subject + key and the same hash is left alone; a different
 *     hash is a hand-edit, and supersedes the row so the old text stays
 *     in the audit trail. Only a subject never seen before inserts.
 *   - **The files are never written.** Import reads; render writes. A
 *     failed or partial import loses nothing.
 *
 * Kind follows the heading's tier, because the tier already encodes the
 * lifecycle: directives are intent, status snapshots are keyed state,
 * historical sections are episodes, people sections are relationships,
 * everything else is a durable fact.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import {
  MAX_SUBJECT_LENGTH,
  MAX_TEXT_LENGTH,
  assertMemory,
  listMemories,
  memoryContentHash,
  replaceStateKey,
  supersedeMemory,
  type MemoryKind,
  type MemoryRow,
  type MemorySource,
} from "../../storage/memory.js";
import { dirs, files } from "../../util/paths.js";
import {
  TIER_ORDER,
  classify,
  collapseFamilies,
  familyKey,
  parseSections,
  type Section,
  type Tier,
} from "../prompt/memory-view.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/** `source.actor` on every row this module writes — the ownership marker. */
const IMPORT_ACTOR = "import";

/** Recorded on the supersede that a changed section causes. */
const RE_IMPORT_REASON = "re-import: file changed";

/** Daily notes only: `YYYY-MM-DD.md`, which excludes `diary-*.md`. */
const DAILY_NOTE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * A heading that is just a date is a day's episode — which is how the
 * render emits an imported daily note, so reading one back produces the
 * episode it came from rather than a fresh fact.
 */
const DATE_HEADING = /^\d{4}-\d{2}-\d{2}$/;

/** How many same-subject rows are scanned for the import-owned one. */
const LOOKUP_LIMIT = 200;

/** Room left for a ` (n/N)` chunk or ` #n` duplicate suffix on a subject. */
const SUBJECT_SUFFIX_ROOM = 16;

/** Cap on a generated state key, inside the store's own 100-char limit. */
const MAX_SLUG_LENGTH = 90;

/**
 * The lifecycle each heading tier maps to. `active` and `general` are
 * durable knowledge with no special lifecycle, so both land as facts.
 */
const KIND_BY_TIER: Readonly<Record<Tier, MemoryKind>> = {
  directive: "directive",
  people: "relationship",
  active: "fact",
  general: "fact",
  status: "state",
  historical: "episode",
};

// ── Types ───────────────────────────────────────────────────────────────────

/** What one import run did, per row. */
export type ImportCounts = {
  inserted: number;
  superseded: number;
  skipped: number;
};

/** One row an import wants to land — the unit of the idempotency check. */
type Claim = {
  kind: MemoryKind;
  subject: string;
  key?: string;
  text: string;
  source: MemorySource;
};

const emptyCounts = (): ImportCounts => ({
  inserted: 0,
  superseded: 0,
  skipped: 0,
});

function addCounts(into: ImportCounts, from: ImportCounts): ImportCounts {
  return {
    inserted: into.inserted + from.inserted,
    superseded: into.superseded + from.superseded,
    skipped: into.skipped + from.skipped,
  };
}

// ── Text shaping ────────────────────────────────────────────────────────────

/**
 * A state key from a family key: `Inbox / CI Watch` → `inbox.ci-watch`.
 * The slash is the family separator the operator already writes, so it
 * becomes the key's dot; everything else collapses to a dash.
 */
function slugKey(family: string): string {
  const slug = family
    .toLowerCase()
    .replace(/\s*\/\s*/g, ".")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-._]+|[-._]+$/g, "");
  return slug.slice(0, MAX_SLUG_LENGTH) || "section";
}

/**
 * Demote `## ` headings inside a claim's body to `### `.
 *
 * A daily note is a whole document and routinely carries its own `## `
 * headings. Stored verbatim, the render would emit them at the top level
 * and the next import would read one row back as several sections — and
 * an embedded `## Active Investigations` would collide with the real
 * section of that name and supersede it. A claim's body therefore never
 * holds a top-level heading. Running this twice changes nothing, which is
 * what keeps the round trip a fixed point.
 */
function demoteHeadings(body: string): string {
  return body.replace(/^##(?=\s)/gm, "###");
}

/** Blank-line-separated paragraphs, trimmed and normalized. */
function paragraphsOf(text: string): string[] {
  return demoteHeadings(text)
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean);
}

/** A single paragraph bigger than the cap — the one place text is lost. */
function hardCut(para: string): string {
  return `${para.slice(0, MAX_TEXT_LENGTH - 1).trimEnd()}…`;
}

/**
 * Pack paragraphs into chunks of at most `MAX_TEXT_LENGTH`. Splitting on
 * paragraph boundaries keeps every chunk readable on its own — a claim
 * cut mid-sentence is worse than no claim. Rejoining the chunks with a
 * blank line reproduces the input exactly, which is what makes
 * import → render → import a fixed point.
 */
function chunkParagraphs(paras: readonly string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const para of paras) {
    const piece = para.length > MAX_TEXT_LENGTH ? hardCut(para) : para;
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length <= MAX_TEXT_LENGTH) {
      current = joined;
      continue;
    }
    if (current) chunks.push(current);
    current = piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Claims ──────────────────────────────────────────────────────────────────

/** Clamp a subject, leaving room for the suffixes appended below. */
function clampSubject(subject: string): string {
  return subject.slice(0, MAX_SUBJECT_LENGTH - SUBJECT_SUFFIX_ROOM).trim();
}

/**
 * Two sections can share a heading. Without a disambiguator the second
 * would supersede the first on every run and vice versa, so occurrence
 * `n > 1` gets a ` #n` marker — deliberately not a parenthetical, which
 * `familyKey` would strip straight back off on the next import.
 */
function disambiguate(
  seen: Map<string, number>,
  kind: MemoryKind,
  subject: string,
): string {
  const slot = `${kind}|${subject}`;
  const occurrence = (seen.get(slot) ?? 0) + 1;
  seen.set(slot, occurrence);
  return occurrence === 1 ? subject : `${subject} #${occurrence}`;
}

/** Spread one section's text across as many rows as the cap needs. */
function claimsFrom(
  base: { kind: MemoryKind; subject: string; key?: string },
  paras: readonly string[],
  source: MemorySource,
): Claim[] {
  const chunks = chunkParagraphs(paras);
  const many = chunks.length > 1;
  return chunks.map((text, index) => {
    const nth = index + 1;
    const subject = many
      ? `${base.subject} (${nth}/${chunks.length})`
      : base.subject;
    const key =
      base.key !== undefined && many && nth > 1
        ? `${base.key}.${nth}`
        : base.key;
    return {
      kind: base.kind,
      subject,
      text,
      source,
      ...(key !== undefined ? { key } : {}),
    };
  });
}

/**
 * One `## ` section → its rows. A `state` section's subject is its key:
 * the render emits keyed rows under their key, so anchoring both on the
 * slug is what keeps import → render → import a no-op.
 */
function sectionClaims(
  section: Section,
  source: MemorySource,
  seen: Map<string, number>,
): Claim[] {
  const dated = DATE_HEADING.test(section.title);
  const tier = TIER_ORDER[classify(section.title)] ?? "general";
  const kind = dated ? "episode" : KIND_BY_TIER[tier];
  const family = familyKey(section.title) || section.title;
  // People sections are per-person and a dated section is one day, so the
  // heading itself is the subject; everything else is keyed on the family
  // so a family's snapshots line up on one row.
  const named = dated || tier === "people" ? section.title : family;
  const key = kind === "state" ? slugKey(family) : undefined;
  const subject = disambiguate(
    seen,
    kind,
    clampSubject(key ?? named) || "untitled",
  );
  const newline = section.body.indexOf("\n");
  const paras = paragraphsOf(
    newline === -1 ? "" : section.body.slice(newline + 1),
  );
  if (paras.length === 0) return [];
  const anchor = key === undefined ? { kind, subject } : { kind, subject, key };
  return claimsFrom(anchor, paras, source);
}

// ── Landing ─────────────────────────────────────────────────────────────────

/** The live row this claim owns, if it has landed before. */
function liveImportRow(claim: Claim): MemoryRow | undefined {
  return listMemories({
    kind: claim.kind,
    subject: claim.subject,
    limit: LOOKUP_LIMIT,
  }).find((row) => row.source.actor === IMPORT_ACTOR && row.key === claim.key);
}

/**
 * Land one claim: skip an unchanged row, supersede a changed one, insert
 * a new one. Keyed state goes in through `replaceStateKey`, so the newest
 * snapshot of a family is the single live row for its key.
 */
function landClaim(claim: Claim): keyof ImportCounts {
  const hash = memoryContentHash(
    claim.kind,
    claim.subject,
    claim.key,
    claim.text,
  );
  const existing = liveImportRow(claim);
  if (existing?.contentHash === hash) return "skipped";
  if (existing) {
    supersedeMemory(existing.id, claim.text, RE_IMPORT_REASON);
    return "superseded";
  }
  if (claim.kind === "state" && claim.key !== undefined) {
    replaceStateKey(claim.key, claim.text, claim.source, {
      subject: claim.subject,
      trust: "operator",
    });
  } else {
    assertMemory({
      kind: claim.kind,
      subject: claim.subject,
      text: claim.text,
      source: claim.source,
      trust: "operator",
    });
  }
  return "inserted";
}

function landAll(claims: Iterable<Claim>): ImportCounts {
  const counts = emptyCounts();
  for (const claim of claims) counts[landClaim(claim)] += 1;
  return counts;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Import `memory.md`: one row per `## ` section, families collapsed
 * first so only a status family's newest snapshot becomes its live state
 * row. A missing file is not an error — a fresh install has none.
 */
export function importMemoryFile(path: string = files.memory): ImportCounts {
  if (!existsSync(path)) return emptyCounts();
  const content = readFileSync(path, "utf8");
  const source: MemorySource = { actor: IMPORT_ACTOR, chat: basename(path) };
  const { kept } = collapseFamilies(parseSections(content).sections);
  const seen = new Map<string, number>();
  return landAll(
    kept.flatMap((section) => sectionClaims(section, source, seen)),
  );
}

/**
 * Import the daily notes: one `episode` per `YYYY-MM-DD.md`, subject the
 * date. `diary-*.md` is first-person writing — a reflection, never a fact
 * source (plan §3.1) — so the filename pattern excludes it. The soul kernel
 * that wrote those files is gone, but its output is still on disk.
 */
export function importDailyNotes(dir: string = dirs.dailyMemory): ImportCounts {
  if (!existsSync(dir)) return emptyCounts();
  let counts = emptyCounts();
  for (const name of readdirSync(dir).sort()) {
    const date = DAILY_NOTE.exec(name)?.[1];
    if (!date) continue;
    const paras = paragraphsOf(readFileSync(join(dir, name), "utf8"));
    if (paras.length === 0) continue;
    const source: MemorySource = { actor: IMPORT_ACTOR, chat: name };
    const claims = claimsFrom(
      { kind: "episode", subject: date },
      paras,
      source,
    );
    counts = addCounts(counts, landAll(claims));
  }
  return counts;
}

/** Both sources, one set of counts — what `talon memory import` runs. */
export function importAll(): ImportCounts {
  return addCounts(importMemoryFile(), importDailyNotes());
}
