import { describe, it, expect } from "vitest";
import { ALL_TOOLS, composeTools } from "../core/tools/index.js";
import type {
  ToolDefinition,
  ToolFrontend,
  ToolTag,
} from "../core/tools/types.js";

describe("ALL_TOOLS registry", () => {
  it("contains tools from every domain", () => {
    const tags = new Set(ALL_TOOLS.map((t) => t.tag));
    expect(tags).toContain("messaging");
    expect(tags).toContain("chat");
    expect(tags).toContain("history");
    expect(tags).toContain("members");
    expect(tags).toContain("media");
    expect(tags).toContain("stickers");
    expect(tags).toContain("scheduling");
    expect(tags).toContain("web");
  });

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has required fields", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.schema).toBeDefined();
      expect(typeof tool.execute).toBe("function");
      expect(tool.tag).toBeTruthy();
    }
  });
});

describe("composeTools()", () => {
  it("returns all tools when no options are given", () => {
    const tools = composeTools();
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });

  it("returns a new array (not a reference to ALL_TOOLS)", () => {
    const tools = composeTools();
    expect(tools).not.toBe(ALL_TOOLS);
  });

  // ── Frontend filtering ────────────────────────────────────────────────

  it("filters tools by telegram frontend", () => {
    const tools = composeTools({ frontend: "telegram" });
    // Should include telegram-specific and universal tools
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.length).toBeLessThan(ALL_TOOLS.length);

    for (const t of tools) {
      const f = t.frontends;
      expect(!f || f.includes("all") || f.includes("telegram")).toBe(true);
    }
  });

  it("filters tools by teams frontend", () => {
    const tools = composeTools({ frontend: "teams" });
    expect(tools.length).toBeGreaterThan(0);

    for (const t of tools) {
      const f = t.frontends;
      expect(!f || f.includes("all") || f.includes("teams")).toBe(true);
    }
  });

  it("excludes telegram-only tools from teams", () => {
    const teamsTools = composeTools({ frontend: "teams" });
    const teamsNames = new Set(teamsTools.map((t) => t.name));

    // react is telegram-only
    expect(teamsNames.has("react")).toBe(false);
    // send_message is teams-only — should be present
    expect(teamsNames.has("send_message")).toBe(true);
  });

  it("excludes teams-only tools from telegram", () => {
    const tgTools = composeTools({ frontend: "telegram" });
    const tgNames = new Set(tgTools.map((t) => t.name));

    // send_message is teams-only
    expect(tgNames.has("send_message")).toBe(false);
    // send is telegram-only — should be present
    expect(tgNames.has("send")).toBe(true);
  });

  it("includes universal tools (no frontends set) for any frontend", () => {
    const universalTools = ALL_TOOLS.filter((t) => !t.frontends);
    expect(universalTools.length).toBeGreaterThan(0);

    for (const frontend of [
      "telegram",
      "teams",
      "terminal",
    ] as ToolFrontend[]) {
      const tools = composeTools({ frontend });
      const names = new Set(tools.map((t) => t.name));
      for (const ut of universalTools) {
        expect(names.has(ut.name)).toBe(true);
      }
    }
  });

  it("includes tools with frontends: ['all'] for any frontend", () => {
    const allFrontendTools = ALL_TOOLS.filter((t) =>
      t.frontends?.includes("all"),
    );
    // Even if there are none right now, the filter logic is tested via universal tools
    for (const frontend of [
      "telegram",
      "teams",
      "terminal",
    ] as ToolFrontend[]) {
      const tools = composeTools({ frontend });
      const names = new Set(tools.map((t) => t.name));
      for (const t of allFrontendTools) {
        expect(names.has(t.name)).toBe(true);
      }
    }
  });

  // ── Tag filtering ─────────────────────────────────────────────────────

  it("filters by tags (include)", () => {
    const tools = composeTools({ tags: ["web"] });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.tag).toBe("web");
    }
  });

  it("filters by multiple tags", () => {
    const tools = composeTools({ tags: ["web", "scheduling"] });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(["web", "scheduling"]).toContain(t.tag);
    }
  });

  it("filters by excludeTags", () => {
    const tools = composeTools({ excludeTags: ["stickers", "media"] });
    for (const t of tools) {
      expect(t.tag).not.toBe("stickers");
      expect(t.tag).not.toBe("media");
    }
    expect(tools.length).toBeLessThan(ALL_TOOLS.length);
  });

  // ── Name exclusion ────────────────────────────────────────────────────

  it("excludes tools by name", () => {
    const tools = composeTools({ excludeNames: ["send", "react"] });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("send")).toBe(false);
    expect(names.has("react")).toBe(false);
    expect(tools.length).toBe(ALL_TOOLS.length - 2);
  });

  // ── Combined filters ──────────────────────────────────────────────────

  it("combines frontend + tag filters", () => {
    const tools = composeTools({ frontend: "telegram", tags: ["messaging"] });
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.tag).toBe("messaging");
      const f = t.frontends;
      expect(!f || f.includes("all") || f.includes("telegram")).toBe(true);
    }
    // Should NOT include teams send_message
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("send_message")).toBe(false);
  });

  it("combines frontend + excludeTags", () => {
    const tools = composeTools({
      frontend: "telegram",
      excludeTags: ["stickers"],
    });
    for (const t of tools) {
      expect(t.tag).not.toBe("stickers");
    }
  });

  it("combines frontend + excludeNames", () => {
    const tools = composeTools({
      frontend: "telegram",
      excludeNames: ["web_search"],
    });
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("web_search")).toBe(false);
    expect(names.has("fetch_url")).toBe(true);
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("returns empty array when tags match nothing", () => {
    const tools = composeTools({ tags: ["nonexistent" as ToolTag] });
    expect(tools).toEqual([]);
  });

  it("returns all tools when excludeNames is empty", () => {
    const tools = composeTools({ excludeNames: [] });
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });

  it("returns all tools when excludeTags is empty", () => {
    const tools = composeTools({ excludeTags: [] });
    expect(tools).toHaveLength(ALL_TOOLS.length);
  });
});
