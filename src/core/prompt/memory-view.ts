/**
 * Persistent-memory view — what the model actually sees of `memory.md`.
 *
 * `memory.md` grows without bound and only the first
 * `MEMORY_INJECT_MAX_CHARS` reach the prompt. Head-slicing that file makes
 * the cut positional while the content is not priority-ordered, so the
 * *least* durable material evicts the most durable. Observed on the live
 * deployment: a 23.6k-char file cut at line 46 of 113, where everything
 * above the line was one facts block plus three near-duplicate
 * `## Inbox / CI Watch (as of …, Run #N)` status snapshots, and
 * `## Active Investigations` — with the root-cause analysis in it — fell
 * below the cut and was never injected at all.
 *
 * So this module makes truncation a *selection* problem:
 *
 *   1. Split the file into `## ` sections (an `h3` stays with its parent).
 *   2. Collapse "state families" — sections whose headings differ only by a
 *      trailing timestamp / run number — down to the newest member. Three
 *      CI-watch snapshots describing the same recurring failures are one
 *      fact, not three.
 *   3. Order by tier (directives → people → active work → general → status
 *      → historical), stable within a tier.
 *   4. Emit whole sections until the budget is spent, and name the ones
 *      that didn't make it so the model knows to `Read` for them.
 *
 * Three deliberate constraints:
 *
 *   - **Under the cap, output is byte-identical to the input.** Reordering
 *     only happens when the alternative is losing content, so deployments
 *     whose memory still fits see no behaviour change and no prompt-cache
 *     churn.
 *   - **Surviving sections are emitted in file order**, not tier order. The
 *     ranking decides *what* survives, not how it reads — and a
 *     tier-ordered body would rewrite the prompt prefix every time a
 *     section's heading changed tier.
 *   - **If nothing fits, fall back to head-slicing.** A single section
 *     larger than the whole budget must still give the model something
 *     rather than an empty memory block.
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/**
 * Cap on how much of `memory.md` is injected into the static prompt.
 * Memory files grow without bound over months of use; injecting all of it
 * bloats EVERY session from its very first turn. 12k chars is roughly 3k
 * tokens — past that, the model gets the ranked selection below plus a
 * pointer, and can Read the file on demand.
 */
export const MEMORY_INJECT_MAX_CHARS = 12_000;

/** Cap on how many omitted section titles are named before eliding the rest. */
const MAX_OMITTED_NAMED = 8;

// ── Tiers ───────────────────────────────────────────────────────────────────

/**
 * Section priority, most-durable first. `status` sits second-to-last because
 * a snapshot is true *now* and false later — it is the content most safely
 * dropped and most cheaply re-derived. `historical` is last for the mirror
 * reason: it will never change again, so it is the least urgent to carry.
 */
const TIER_ORDER = [
  "directive",
  "people",
  "active",
  "general",
  "status",
  "historical",
] as const;

type Tier = (typeof TIER_ORDER)[number];

const tier = (name: Tier): number => TIER_ORDER.indexOf(name);

/**
 * Heading classifiers. First match wins, so order is the policy: a heading
 * reading "Active investigation status" is active work, not a snapshot.
 * `general` is the unmatched default and ranks above `status` — a section
 * nobody labelled is more likely durable knowledge than a dated snapshot.
 */
const MATCHERS: readonly { readonly tier: Tier; readonly match: RegExp }[] = [
  {
    tier: "historical",
    match:
      /\b(historical|history|archived?|superseded|resolved|closed|completed|past|old)\b/i,
  },
  {
    tier: "directive",
    match: /\b(directives?|preferences?|instructions?|rules?)\b/i,
  },
  {
    tier: "active",
    match:
      /\b(active|current|investigations?|open|pending|todo|follow.?ups?|blocked|in.progress|priorit(?:y|ies)|goals?)\b/i,
  },
  {
    tier: "people",
    match: /\b(users?|people|person|contacts?|team|about)\b/i,
  },
  {
    tier: "status",
    match: /\b(as of|run #|status|health|watch|inbox|snapshot|report)\b/i,
  },
];

const STATUS_TIER = tier("status");
const GENERAL_TIER = tier("general");

function classify(title: string): number {
  for (const m of MATCHERS) {
    if (m.match.test(title)) return tier(m.tier);
  }
  return GENERAL_TIER;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

type Section = {
  /** Heading with markup and trailing qualifiers stripped — the display name. */
  readonly title: string;
  /** Whole section including its heading and any `###` children. */
  readonly body: string;
  /** Index in the original file, for stable ordering within a tier. */
  readonly order: number;
  readonly tier: number;
  /** Key shared by every member of a state family (see `familyKey`). */
  readonly family: string;
  /** Recency score used to pick a family's survivor; higher is newer. */
  readonly recency: string;
};

/** Strip `## ` markup and bold markers from a heading line. */
function headingTitle(heading: string): string {
  return heading
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
}

/**
 * The family a section belongs to: its title minus temporal qualifiers.
 * `Inbox / CI Watch (as of 2026-07-03, Run #134)` → `inbox / ci watch`. That
 * parenthetical is exactly what makes each snapshot look unique while the
 * underlying topic repeats, so removing it is what lets a family collapse.
 */
function familyKey(title: string): string {
  return title
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*[—–-]\s*(?:as of|run #).*$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * A sortable recency key: `<date>|<run>`, both fixed-width so a plain string
 * compare orders correctly. Both fields are zero-filled when absent rather
 * than left empty — an empty field would make the `|` separator the first
 * character compared, and `|` sorts *above* every digit, which would rank an
 * undated section as newer than a dated one. A heading with neither field
 * scores lowest and falls back to file order, where the dream agent puts the
 * newest section first.
 */
function recencyKey(heading: string): string {
  const date = /(\d{4}-\d{2}-\d{2})/.exec(heading)?.[1] ?? "0000-00-00";
  const run = /\brun\s*#\s*(\d+)/i.exec(heading)?.[1] ?? "0";
  return `${date}|${run.padStart(10, "0")}`;
}

/**
 * Split content into a leading preamble (the `#` title and anything before
 * the first `## `) plus one entry per `## ` section. The split is on `## `
 * only, so an `h3` travels with the section it belongs to.
 */
function parseSections(content: string): {
  preamble: string;
  sections: Section[];
} {
  const parts = content.split(/^(?=## )/m);
  const first = parts[0] ?? "";
  const preamble = first.startsWith("## ") ? "" : (parts.shift() ?? "");
  const sections: Section[] = [];
  for (const body of parts) {
    if (!body.trim()) continue;
    const heading = body.split("\n", 1)[0] ?? "";
    const title = headingTitle(heading);
    sections.push({
      title,
      body,
      order: sections.length,
      tier: classify(title),
      family: familyKey(title),
      recency: recencyKey(heading),
    });
  }
  return { preamble, sections };
}

/**
 * Keep one section per state family: the newest by `recency`, and on a tie
 * the one that appeared first. Only the `status` tier collapses — two
 * sections about people are two different people, not two snapshots of one.
 */
function collapseFamilies(sections: readonly Section[]): {
  kept: Section[];
  dropped: Section[];
} {
  const winners = new Map<string, Section>();
  for (const s of sections) {
    if (s.tier !== STATUS_TIER) continue;
    const held = winners.get(s.family);
    if (!held || s.recency > held.recency) winners.set(s.family, s);
  }
  const kept: Section[] = [];
  const dropped: Section[] = [];
  for (const s of sections) {
    if (s.tier !== STATUS_TIER || winners.get(s.family) === s) kept.push(s);
    else dropped.push(s);
  }
  return { kept, dropped };
}

// ── Public API ──────────────────────────────────────────────────────────────

/** The memory block to inject, plus what had to be left out of it. */
export type MemoryView = {
  /** Text to render into the persistent-memory prompt section. */
  text: string;
  /** True when the file did not fit whole — drives the "Read for more" note. */
  truncated: boolean;
  /** Human-readable list of ranked-out sections, or "" when none. */
  omitted: string;
};

/** Head-slice at the cap, snapping back to a newline so the cut isn't mid-line. */
function headSlice(content: string, budget: number): string {
  const head = content.slice(0, budget);
  const lastNewline = head.lastIndexOf("\n");
  return (lastNewline > 0 ? head.slice(0, lastNewline) : head).trimEnd();
}

/** Render omitted titles as one prose list, eliding a long tail. */
function formatOmitted(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  if (titles.length <= MAX_OMITTED_NAMED) return titles.join("; ");
  const named = titles.slice(0, MAX_OMITTED_NAMED).join("; ");
  return `${named}; and ${titles.length - MAX_OMITTED_NAMED} more`;
}

/**
 * Render the injectable view of `memory.md`.
 *
 * Under the cap this is the identity function — same bytes in, same bytes
 * out. Over the cap, sections are collapsed and ranked as described in the
 * module docstring, and anything that didn't fit is named in `omitted`.
 */
export function renderMemoryView(
  content: string,
  budget: number = MEMORY_INJECT_MAX_CHARS,
): MemoryView {
  if (content.length <= budget) {
    return { text: content, truncated: false, omitted: "" };
  }

  const { preamble, sections } = parseSections(content);
  const { kept, dropped } = collapseFamilies(sections);

  // Tier first, then original file order — stable within a tier so the
  // author's own ordering survives wherever priority doesn't decide.
  const ranked = [...kept].sort((a, b) => a.tier - b.tier || a.order - b.order);

  const head = preamble.trimEnd();
  let spent = head.length;
  const chosen: Section[] = [];
  const omitted: Section[] = [...dropped];
  for (const s of ranked) {
    const cost = s.body.trimEnd().length + 2; // body + section separator
    if (spent + cost <= budget) {
      spent += cost;
      chosen.push(s);
    } else {
      omitted.push(s);
    }
  }

  // Nothing fit — a single section is bigger than the whole budget. Degrade
  // to the old behaviour rather than injecting an empty memory block.
  if (chosen.length === 0) {
    return { text: headSlice(content, budget), truncated: true, omitted: "" };
  }

  chosen.sort((a, b) => a.order - b.order);
  const body = chosen.map((s) => s.body.trimEnd()).join("\n\n");

  return {
    text: head ? `${head}\n\n${body}` : body,
    truncated: true,
    omitted: formatOmitted(
      omitted
        .sort((a, b) => a.tier - b.tier || a.order - b.order)
        .map((s) => s.title),
    ),
  };
}
