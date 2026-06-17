/**
 * Pure-function unit tests for src/backend/kilo/models.ts helpers.
 *
 * Covers the small utility functions that aren't exercised by the higher-level
 * resolveOpenCodeModelInput / catalog tests:
 *   - guessProviderID            — model.id → provider heuristic
 *   - getBucketPriority          — provider-bucket ordering for resolveProviderID
 *   - normalizeModelLookup       — query canonicalisation
 *   - parseOpenCodeModelQuery    — "<provider>/<model>" splitter
 *
 * These are pure functions over strings — no SDK and no catalog.
 * They're cheap to test and they're exactly where a refactor regression
 * is most likely to slip past tsc.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const {
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
} = await import("../backend/kilo/models/index.js");

// ---------------------------------------------------------------------------
// guessProviderID — string-pattern heuristic mapping a model.id to a provider.
// Used by resolveProviderID() as a tiebreaker when /provider returns the same
// model under multiple provider buckets. Must default to "opencode" when no
// pattern matches.
// ---------------------------------------------------------------------------
describe("guessProviderID", () => {
  it("maps GPT-family IDs to openai", () => {
    expect(guessProviderID("gpt-5")).toBe("openai");
    expect(guessProviderID("gpt-4o")).toBe("openai");
    expect(guessProviderID("GPT-5")).toBe("openai");
  });

  it("maps o1/o3/o4 reasoning IDs to openai", () => {
    expect(guessProviderID("o1-preview")).toBe("openai");
    expect(guessProviderID("o3-mini")).toBe("openai");
    expect(guessProviderID("o4")).toBe("openai");
  });

  it("maps gemini IDs to google", () => {
    expect(guessProviderID("gemini-2.5-pro")).toBe("google");
    expect(guessProviderID("Gemini-Ultra")).toBe("google");
  });

  it("maps claude IDs to anthropic", () => {
    expect(guessProviderID("claude-opus-4-7")).toBe("anthropic");
    expect(guessProviderID("Claude-3-Haiku")).toBe("anthropic");
  });

  it("falls back to opencode for unrecognised IDs", () => {
    expect(guessProviderID("big-pickle")).toBe("opencode");
    expect(guessProviderID("nemotron-3-super-free")).toBe("opencode");
    expect(guessProviderID("kimi-k2.6")).toBe("opencode");
  });

  it("does not match 'o' followed by other digits (2, 5, 7 etc) — only 1/3/4", () => {
    // Regression: the pattern is /gpt|^o[134]/ — only o1, o3, o4 anchored.
    // A model named "o2-foo" shouldn't accidentally get routed to openai.
    expect(guessProviderID("o2-foo")).toBe("opencode");
    expect(guessProviderID("o5-bar")).toBe("opencode");
  });
});

// ---------------------------------------------------------------------------
// getBucketPriority — used by resolveProviderID to break ties when /provider
// returns multiple buckets containing the same model ID. Lower = preferred.
// ---------------------------------------------------------------------------
describe("getBucketPriority", () => {
  it("prefers connected over configured over available over all", () => {
    expect(getBucketPriority("connected")).toBeLessThan(
      getBucketPriority("configured"),
    );
    expect(getBucketPriority("configured")).toBeLessThan(
      getBucketPriority("available"),
    );
    expect(getBucketPriority("available")).toBeLessThan(
      getBucketPriority("all"),
    );
  });

  it("returns a stable fallback for unknown buckets", () => {
    // Whatever the exact number is, it must be >= the known buckets so the
    // sort downstream treats unknown buckets as the lowest priority.
    const unknown = getBucketPriority("some-future-bucket");
    expect(unknown).toBeGreaterThanOrEqual(getBucketPriority("all"));
  });
});

// ---------------------------------------------------------------------------
// normalizeModelLookup — the query string normaliser used everywhere model
// matching happens. Lowercase, strip ` " ', collapse whitespace into "-".
// ---------------------------------------------------------------------------
describe("normalizeModelLookup", () => {
  it("lowercases the input", () => {
    expect(normalizeModelLookup("GPT-5")).toBe("gpt-5");
    expect(normalizeModelLookup("Claude Opus 4-7")).toBe("claude-opus-4-7");
  });

  it("strips backticks, single, and double quotes", () => {
    expect(normalizeModelLookup("`gpt-5`")).toBe("gpt-5");
    expect(normalizeModelLookup("'gpt-5'")).toBe("gpt-5");
    expect(normalizeModelLookup('"gpt-5"')).toBe("gpt-5");
    expect(normalizeModelLookup('`"gpt-5\'"')).toBe("gpt-5");
  });

  it("collapses runs of whitespace into a single hyphen", () => {
    expect(normalizeModelLookup("gpt 5")).toBe("gpt-5");
    expect(normalizeModelLookup("gpt   5")).toBe("gpt-5");
    expect(normalizeModelLookup("gpt\t5")).toBe("gpt-5");
  });

  it("trims surrounding whitespace before normalising", () => {
    expect(normalizeModelLookup("  gpt-5  ")).toBe("gpt-5");
  });

  it("preserves embedded / and : (Kilo model IDs use both)", () => {
    expect(normalizeModelLookup("inclusionai/ling-2.6-1t:free")).toBe(
      "inclusionai/ling-2.6-1t:free",
    );
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeModelLookup("")).toBe("");
    expect(normalizeModelLookup("   ")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseOpenCodeModelQuery — splits "<provider>/<model>" or "<provider>:<model>"
// queries. Returns { modelQuery } only (no provider) when there's no separator
// or when the separator is at the very start/end. The "fast path" in
// resolveOpenCodeModelInput exists because Kilo model IDs frequently embed
// both / and : *inside* the ID itself.
// ---------------------------------------------------------------------------
describe("parseOpenCodeModelQuery", () => {
  it("splits on /", () => {
    expect(parseOpenCodeModelQuery("openai/gpt-5")).toEqual({
      providerQuery: "openai",
      modelQuery: "gpt-5",
    });
  });

  it("splits on :", () => {
    expect(parseOpenCodeModelQuery("openai:gpt-5")).toEqual({
      providerQuery: "openai",
      modelQuery: "gpt-5",
    });
  });

  it("prefers the earlier separator when both / and : are present", () => {
    // "kilo/free:turbo" — earlier "/" wins. modelQuery still contains ":".
    expect(parseOpenCodeModelQuery("kilo/free:turbo")).toEqual({
      providerQuery: "kilo",
      modelQuery: "free:turbo",
    });
    // "kilo:free/turbo" — earlier ":" wins. modelQuery still contains "/".
    expect(parseOpenCodeModelQuery("kilo:free/turbo")).toEqual({
      providerQuery: "kilo",
      modelQuery: "free/turbo",
    });
  });

  it("returns modelQuery only when there's no separator", () => {
    expect(parseOpenCodeModelQuery("gpt-5")).toEqual({ modelQuery: "gpt-5" });
  });

  it("returns modelQuery only when the separator is at the very start", () => {
    // Leading "/" — there's no provider to extract.
    expect(parseOpenCodeModelQuery("/gpt-5")).toEqual({ modelQuery: "/gpt-5" });
    expect(parseOpenCodeModelQuery(":gpt-5")).toEqual({ modelQuery: ":gpt-5" });
  });

  it("returns modelQuery only when the separator is at the very end", () => {
    expect(parseOpenCodeModelQuery("openai/")).toEqual({
      modelQuery: "openai/",
    });
    expect(parseOpenCodeModelQuery("openai:")).toEqual({
      modelQuery: "openai:",
    });
  });

  it("trims whitespace around the components", () => {
    expect(parseOpenCodeModelQuery("  openai / gpt-5  ")).toEqual({
      providerQuery: "openai",
      modelQuery: "gpt-5",
    });
  });

  it("treats a single-character provider as the whole query (bare-id fallback)", () => {
    // For a query like "x/foo", separator is at index 1 — provider="x" is OK.
    expect(parseOpenCodeModelQuery("x/foo")).toEqual({
      providerQuery: "x",
      modelQuery: "foo",
    });
  });

  it("falls back to bare modelQuery when either component is empty after trimming", () => {
    // " /foo" → providerQuery would be "", modelQuery "foo". The splitter
    // bails to the whole-string fallback because providerQuery is blank.
    expect(parseOpenCodeModelQuery(" /foo")).toEqual({ modelQuery: "/foo" });
  });
});
