import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock picocolors to return raw strings (no ANSI)
vi.mock("picocolors", () => ({
  default: {
    cyan: (s: string) => s,
    green: (s: string) => s,
    dim: (s: string) => s,
    red: (s: string) => s,
    bold: (s: string) => s,
    yellow: (s: string) => s,
    underline: (s: string) => s,
  },
}));

import {
  wrap,
  formatTimeAgo,
  extractToolDetail,
  cleanToolName,
  createRenderer,
} from "../frontend/terminal/renderer.js";

// ── wrap ─────────────────────────────────────────────────────────────────────

describe("wrap", () => {
  it("preserves short lines", () => {
    expect(wrap("hello world", 2, 80)).toBe("  hello world");
  });

  it("wraps long lines", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    const result = wrap(text, 2, 30);
    // Every line should be ≤ 30 chars
    for (const line of result.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("preserves existing newlines", () => {
    const result = wrap("line1\nline2", 2, 80);
    expect(result).toBe("  line1\n  line2");
  });

  it("returns text as-is if width too narrow", () => {
    expect(wrap("test", 70, 80)).toBe("test");
  });
});

// ── formatTimeAgo ────────────────────────────────────────────────────────────

describe("formatTimeAgo", () => {
  it('returns "just now" for recent timestamps', () => {
    expect(formatTimeAgo(Date.now())).toBe("just now");
    expect(formatTimeAgo(Date.now() - 30_000)).toBe("just now");
  });

  it("returns minutes for < 1 hour", () => {
    expect(formatTimeAgo(Date.now() - 5 * 60_000)).toBe("5m ago");
    expect(formatTimeAgo(Date.now() - 59 * 60_000)).toBe("59m ago");
  });

  it("returns hours for < 1 day", () => {
    expect(formatTimeAgo(Date.now() - 2 * 3_600_000)).toBe("2h ago");
    expect(formatTimeAgo(Date.now() - 23 * 3_600_000)).toBe("23h ago");
  });

  it("returns days for >= 1 day", () => {
    expect(formatTimeAgo(Date.now() - 86_400_000)).toBe("1d ago");
    expect(formatTimeAgo(Date.now() - 7 * 86_400_000)).toBe("7d ago");
  });
});

// ── extractToolDetail ────────────────────────────────────────────────────────

describe("extractToolDetail", () => {
  it("prefers description over command", () => {
    const detail = extractToolDetail(
      { command: "git status --long", description: "Show git status" },
      80,
    );
    expect(detail).toBe("Show git status");
  });

  it("falls back to command when no description", () => {
    const detail = extractToolDetail({ command: "ls -la" }, 80);
    expect(detail).toBe("ls -la");
  });

  it("truncates long commands with ellipsis", () => {
    const longCmd = "a".repeat(100);
    const detail = extractToolDetail({ command: longCmd }, 50);
    expect(detail.length).toBeLessThanOrEqual(50);
    expect(detail).toMatch(/\.\.\.$/);
  });

  it("extracts file_path", () => {
    expect(extractToolDetail({ file_path: "/src/index.ts" }, 80)).toBe(
      "/src/index.ts",
    );
  });

  it("extracts pattern + path", () => {
    expect(extractToolDetail({ pattern: "*.ts", path: "/src" }, 80)).toBe(
      "*.ts in /src",
    );
  });

  it("extracts pattern alone", () => {
    expect(extractToolDetail({ pattern: "*.ts" }, 80)).toBe("*.ts");
  });

  it("extracts action", () => {
    expect(extractToolDetail({ action: "deploy" }, 80)).toBe("deploy");
  });

  it("extracts build_number with hash", () => {
    expect(extractToolDetail({ build_number: 42 }, 80)).toBe("#42");
  });

  it("falls back to key=value pairs", () => {
    expect(extractToolDetail({ foo: "bar", num: 5 }, 80)).toBe(
      "foo=bar, num=5",
    );
  });

  it("skips _chatId in fallback", () => {
    expect(extractToolDetail({ _chatId: "1", foo: "bar" }, 80)).toBe("foo=bar");
  });

  it("returns empty string for empty input", () => {
    expect(extractToolDetail({}, 80)).toBe("");
  });
});

// ── cleanToolName ────────────────────────────────────────────────────────────

describe("cleanToolName", () => {
  it("strips MCP server prefix", () => {
    expect(cleanToolName("mcp__npuw-tools__jenkins_list_builds")).toBe(
      "jenkins_list_builds",
    );
  });

  it("handles trailing double-underscore by returning original (empty last segment)", () => {
    // When last segment is empty, || fallback returns original name
    expect(cleanToolName("mcp__server__")).toBe("mcp__server__");
  });

  it("preserves non-MCP names", () => {
    expect(cleanToolName("Bash")).toBe("Bash");
    expect(cleanToolName("Read")).toBe("Read");
  });

  it("handles single-segment MCP name", () => {
    expect(cleanToolName("mcp__tool")).toBe("tool");
  });
});

// ── createRenderer (output capture) ──────────────────────────────────────────

describe("createRenderer", () => {
  let output: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    output = [];
    originalWrite = process.stdout.write;
    process.stdout.write = vi.fn((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it("writeln outputs text with newline", () => {
    const r = createRenderer(80);
    r.writeln("hello");
    expect(output.join("")).toContain("hello\n");
  });

  it("writeSystem wraps in dim", () => {
    const r = createRenderer(80);
    r.writeSystem("test message");
    expect(output.join("")).toContain("test message");
  });

  it("writeError includes error marker", () => {
    const r = createRenderer(80);
    r.writeError("something failed");
    const text = output.join("");
    expect(text).toContain("something failed");
  });

  it("renderAssistantMessage includes Talon header", () => {
    const r = createRenderer(80);
    r.renderAssistantMessage("Hello world");
    const text = output.join("");
    expect(text).toContain("Talon");
    expect(text).toContain("Hello world");
  });

  it("renderToolCall shows tool name and detail", () => {
    const r = createRenderer(80);
    r.renderToolCall("Bash", {
      command: "git status",
      description: "Show git status",
    });
    const text = output.join("");
    expect(text).toContain("Bash");
    expect(text).toContain("Show git status");
  });

  it("renderToolCall hides TodoRead/TodoWrite", () => {
    const r = createRenderer(80);
    r.renderToolCall("TodoRead", { _chatId: "1" });
    r.renderToolCall("TodoWrite", { _chatId: "1" });
    const text = output.join("");
    expect(text).not.toContain("TodoRead");
    expect(text).not.toContain("TodoWrite");
  });

  it("renderToolCall strips MCP prefix in display", () => {
    const r = createRenderer(80);
    r.renderToolCall("mcp__server__my_tool", { action: "test" });
    const text = output.join("");
    expect(text).toContain("my tool"); // underscores → spaces
    expect(text).not.toContain("mcp__");
  });

  it("renderStats shows duration and tokens", () => {
    const r = createRenderer(80);
    r.renderStats(1500, 100, 50, 80, 3);
    const text = output.join("");
    expect(text).toContain("1.5s");
    expect(text).toContain("150 tok");
    expect(text).toContain("cache");
    expect(text).toContain("3 tools");
  });

  it("renderStats pluralizes tool count correctly", () => {
    const r = createRenderer(80);

    output = [];
    r.renderStats(1000, 10, 5, 0, 1);
    expect(output.join("")).toContain("1 tool");
    expect(output.join("")).not.toContain("1 tools");
  });

  it("uses the provided column width", () => {
    const r = createRenderer(40);
    expect(r.cols).toBe(40);
  });
});

// Need to import afterEach for cleanup
import { afterEach } from "vitest";
