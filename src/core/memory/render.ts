/**
 * Typed memory rows → a `memory.md`-shaped document.
 *
 * The inverse of import.ts, and the second half of "markdown becomes a
 * view" (plan §3.1): the store holds the claims, the file is a rendered
 * projection of them — still human-readable, still `Read`-able, still
 * editable, but no longer authoritative.
 *
 * Two properties matter more than prettiness:
 *
 *   - **Deterministic.** The same rows render to the same bytes, every
 *     time. A file that churns on every render is a file nobody can diff
 *     and a prompt prefix that never caches.
 *   - **A fixed point with import.** Chunked rows are regrouped under
 *     their base subject and keyed state renders under its key, so
 *     importing this document back produces exactly the rows it came
 *     from and reports zero inserts. That round trip is what lets a
 *     hand-edit be folded back instead of duplicated.
 *
 * Truncation is selection, not slicing: sections are dropped whole, from
 * the bottom of the ranking, and the tail is named so the reader knows
 * to ask the store for the rest.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";

import {
  listMemories,
  type MemoryKind,
  type MemoryRow,
} from "../../storage/memory.js";
import { dirs, files } from "../../util/paths.js";
import { toYMD } from "../../util/time.js";
import {
  MEMORY_INJECT_MAX_CHARS,
  headingTitle,
} from "../prompt/memory-view.js";

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Kind order in the document, most durable first. `reflection` is absent
 * on purpose: the diary is the persona layer and never a fact source, so
 * it is not part of the memory projection (plan §3.1).
 */
const KIND_ORDER: readonly MemoryKind[] = [
  "directive",
  "relationship",
  "fact",
  "state",
  "episode",
];

/** How many rows per kind the default render pulls from the store. */
const KIND_ROW_LIMIT = 500;

/** The preamble. Import ignores everything above the first `## `. */
const HEADER =
  "# Memory\n\n" +
  "_Rendered from the typed memory store. Edit freely — " +
  "`talon memory import` folds changes back._\n";

/** The ` (n/N)` marker import appends when a section outgrew the text cap. */
const CHUNK_SUFFIX = /^(.*) \((\d+)\/(\d+)\)$/;

// ── Ordering ────────────────────────────────────────────────────────────────

/** One row placed under its section heading. */
type Piece = { label: string; index: number; row: MemoryRow };

/**
 * A keyed row renders under its key, which is the more specific label and
 * the one import reads back. Chunk `n > 1` carries a `.n` key suffix so
 * each chunk owns a distinct key; the heading drops it again.
 */
function stateLabel(row: MemoryRow, index: number): string {
  const key = row.key ?? row.subject;
  const suffix = `.${index}`;
  return index > 1 && key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
}

function pieceOf(row: MemoryRow): Piece {
  const chunk = CHUNK_SUFFIX.exec(row.subject);
  const index = chunk ? Number(chunk[2]) : 1;
  const base = chunk?.[1] ?? row.subject;
  return {
    label: row.kind === "state" ? stateLabel(row, index) : base,
    index,
    row,
  };
}

/** Pinned first, then kind, then salience, then recency; id breaks ties. */
function compareRows(a: MemoryRow, b: MemoryRow): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    b.salience - a.salience ||
    b.lastSeenAt - a.lastSeenAt ||
    a.id - b.id
  );
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** One heading plus its rows, blank-line separated, chunks back in order. */
function renderSection(label: string, pieces: readonly Piece[]): string {
  const body = [...pieces]
    .sort((a, b) => a.index - b.index)
    .map((piece) => piece.row.text)
    .join("\n\n");
  return `## ${headingTitle(label)}\n\n${body}\n`;
}

/**
 * Group ranked rows into sections. A section takes the position of its
 * best-ranked row, so the ranking survives the grouping.
 */
function sectionsFrom(rows: readonly MemoryRow[]): string[] {
  const groups = new Map<string, Piece[]>();
  const ranked = rows
    .filter((row) => KIND_ORDER.includes(row.kind))
    .sort(compareRows);
  for (const row of ranked) {
    const piece = pieceOf(row);
    const held = groups.get(piece.label);
    if (held) held.push(piece);
    else groups.set(piece.label, [piece]);
  }
  return [...groups].map(([label, pieces]) => renderSection(label, pieces));
}

/** The pointer that replaces whatever the budget could not carry. */
function moreLine(omitted: number): string {
  const plural = omitted === 1 ? "section" : "sections";
  return `_… ${omitted} more ${plural} in the store — \`talon memory list\`_\n`;
}

/**
 * Take whole sections until the budget is spent, then give back sections
 * until the "N more" pointer fits too — the document as a whole stays
 * inside the budget, and every cut lands on a section boundary. The
 * header plus that pointer is the floor: a budget smaller than those two
 * still gets them, because a document that cannot say what it dropped is
 * worse than one slightly over budget.
 */
function selectSections(
  sections: readonly string[],
  budget: number,
): { taken: readonly string[]; omitted: number } {
  let spent = HEADER.length;
  let take = 0;
  for (const section of sections) {
    if (spent + section.length + 1 > budget) break;
    spent += section.length + 1;
    take += 1;
  }
  let omitted = sections.length - take;
  while (
    take > 0 &&
    omitted > 0 &&
    spent + moreLine(omitted).length + 1 > budget
  ) {
    take -= 1;
    spent -= sections[take]!.length + 1;
    omitted += 1;
  }
  return { taken: sections.slice(0, take), omitted };
}

/** Options shared by the render and the file write. */
export type RenderOptions = {
  /** Char budget for the whole document. Defaults to the inject cap. */
  budget?: number;
  /**
   * Rows to render instead of the live store — the seam the tests and
   * (from PR 9) the pre-ranked core view use.
   */
  rows?: readonly MemoryRow[];
};

function liveRows(): MemoryRow[] {
  return KIND_ORDER.flatMap((kind) =>
    listMemories({ kind, limit: KIND_ROW_LIMIT }),
  );
}

/**
 * Render the live store as a `memory.md` document. Same rows in, same
 * bytes out.
 */
export function renderMemoryMarkdown(opts: RenderOptions = {}): string {
  const sections = sectionsFrom(opts.rows ?? liveRows());
  const { taken, omitted } = selectSections(
    sections,
    opts.budget ?? MEMORY_INJECT_MAX_CHARS,
  );
  const parts = [HEADER, ...taken];
  if (omitted > 0) parts.push(moreLine(omitted));
  return parts.join("\n");
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** Where a render went, and what it displaced. */
export type RenderWrite = {
  path: string;
  bytes: number;
  /** The archived copy of the previous file, when one was taken. */
  backup?: string;
};

/**
 * Copy the file aside before it is replaced — once per day, so a render
 * loop can't bury the archive, and never overwriting an existing backup,
 * so the first render of the day keeps the hand-written original.
 */
function backUp(path: string, archiveDir: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const dest = join(archiveDir, `memory-before-render-${toYMD(new Date())}.md`);
  if (existsSync(dest)) return undefined;
  mkdirSync(archiveDir, { recursive: true });
  copyFileSync(path, dest);
  return dest;
}

/** Render the store over `memory.md`, keeping a dated copy of what was there. */
export function writeRenderedMemory(
  path: string = files.memory,
  opts: RenderOptions & { archiveDir?: string } = {},
): RenderWrite {
  const markdown = renderMemoryMarkdown(opts);
  const backup = backUp(path, opts.archiveDir ?? dirs.memoryArchive);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic.sync(path, markdown);
  return {
    path,
    bytes: markdown.length,
    ...(backup !== undefined ? { backup } : {}),
  };
}
