import { beforeEach, describe, expect, it } from "vitest";
import { clearModels, registerModels } from "../core/models/catalog.js";
import {
  formatCompactModelLabel,
  formatDuration,
  formatModelLabel,
  formatModelOptionLabel,
  getTelegramModelOptions,
  isSelectedModel,
  renderMetricsMessages,
  renderEffortRows,
  renderSettingsKeyboard,
  renderSettingsText,
} from "../frontend/telegram/helpers/index.js";

describe("telegram helpers", () => {
  beforeEach(() => {
    clearModels();
    // Post-merge state: convertSdkModels collapses base/1M/claude-* variants
    // of the same family+version into a single canonical entry. This fixture
    // is what the registry looks like after that merge.
    registerModels([
      {
        id: "default",
        displayName: "Sonnet 4.6",
        description: "Sonnet 4.6 · Best for everyday tasks",
        aliases: [
          "sonnet",
          "sonnet[1m]",
          "claude-sonnet-4-6",
          "claude-sonnet-4-6[1m]",
        ],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "opus[1m]",
        displayName: "Opus 4.6",
        description: "Opus 4.6 with 1M context · Large context window",
        aliases: ["opus", "claude-opus-4-6", "claude-opus-4-6[1m]"],
        provider: "anthropic",
        fallback: "default",
      },
      {
        id: "haiku",
        displayName: "Haiku 4.5",
        description: "Haiku 4.5 · Fastest for quick answers",
        aliases: ["claude-haiku-4-5"],
        provider: "anthropic",
      },
    ]);
  });

  it("matches legacy aliases and 1M variants to the canonical selected model", () => {
    expect(isSelectedModel("claude-sonnet-4-6", "default")).toBe(true);
    // sonnet[1m] is merged into "default" — same canonical model.
    expect(isSelectedModel("sonnet[1m]", "default")).toBe(true);
    expect(isSelectedModel("claude-sonnet-4-6[1m]", "default")).toBe(true);
    expect(isSelectedModel("claude-sonnet-4-6", "haiku")).toBe(false);
  });

  it("formats labels using backend-registered displayName", () => {
    expect(formatModelLabel("default")).toBe("Sonnet 4.6");
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    // 1M variants collapse into the same entry — same clean label.
    expect(formatModelLabel("sonnet[1m]")).toBe("Sonnet 4.6");
    expect(formatModelLabel("opus[1m]")).toBe("Opus 4.6");
    expect(formatModelLabel("claude-opus-4-6")).toBe("Opus 4.6");
    expect(formatModelOptionLabel(getTelegramModelOptions()[0]!)).toBe(
      "Sonnet 4.6",
    );
    expect(formatCompactModelLabel(getTelegramModelOptions()[1]!)).toBe(
      "Opus 4.6",
    );
  });

  it("shows one option per family+version (base/1M variants merged)", () => {
    expect(getTelegramModelOptions().map((model) => model.id)).toEqual([
      "default",
      "opus[1m]",
      "haiku",
    ]);
  });

  it("marks the canonical model button as selected for legacy aliases", () => {
    const buttons = renderSettingsKeyboard(
      "claude-sonnet-4-6",
      "adaptive",
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      ["off", "low", "medium", "high", "max"],
    )
      .flat()
      .map((button) => button.text);

    expect(buttons).toContain("\u2713 Sonnet 4.6");
  });

  it("renders only the reasoning levels registered for the active model", () => {
    const buttons = renderEffortRows(
      "adaptive",
      ["minimal", "high", "xhigh"],
      "effort:",
    );
    const labels = buttons.flat().map((button) => button.text);

    expect(labels).toEqual(["Minimal", "High", "XHigh", "✓ Auto"]);
    expect(labels).not.toContain("Max");
    expect(labels).not.toContain("Off");
  });

  it("hides effort buttons when the active model registers no levels", () => {
    const buttons = renderSettingsKeyboard("default", "adaptive", true)
      .flat()
      .map((button) => button.callback_data);

    expect(buttons.some((data) => data.startsWith("settings:effort:"))).toBe(
      false,
    );
  });
});

describe("formatDuration", () => {
  it("preserves millisecond precision for subsecond values", () => {
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("keeps second-and-up formatting intact", () => {
    expect(formatDuration(1_500)).toBe("1s");
    expect(formatDuration(65_000)).toBe("1m 5s");
  });
});

describe("renderSettingsText", () => {
  // Telegram parses messages with parse_mode=HTML; any literal `<word>` in a
  // detail line (e.g. backend hints like "use /model <name>") would be
  // mis-read as a tag and reject the entire send. Detail strings come from
  // backends that also feed Discord (Markdown), so they stay plain text and
  // the Telegram frontend escapes per-line.
  it("escapes HTML special chars in modelDetails", () => {
    const out = renderSettingsText("default", "high", true, 60_000, [
      "Hint: use /model <name> to switch.",
      "Provider: A & B",
    ]);
    expect(out).not.toMatch(/<name>/);
    expect(out).toContain("&lt;name&gt;");
    expect(out).toContain("A &amp; B");
  });
});

describe("renderMetricsMessages", () => {
  it("formats latency metrics with millisecond precision", () => {
    const messages = renderMetricsMessages({
      counters: { queries_total: 7 },
      histograms: {
        response_latency_ms: {
          count: 3,
          avg: 900,
          min: 250,
          max: 2_000,
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("avg=900ms");
    expect(messages[0]).toContain("min=250ms");
    expect(messages[0]).toContain("max=2s");
  });

  it("renders count histograms as plain numbers under Distributions", () => {
    const messages = renderMetricsMessages({
      counters: {},
      histograms: {
        response_latency_ms: {
          count: 3,
          avg: 900,
          min: 250,
          max: 2_000,
        },
        tool_calls_per_turn: { count: 21, avg: 9, min: 1, max: 100 },
      },
    });

    const out = messages.join("\n");
    // Duration histograms stay under Latency with time units…
    expect(out).toContain("<b>Latency</b>");
    expect(out).toContain("avg=900ms");
    // …while per-turn counts get their own section, unit-free.
    expect(out).toContain("<b>Distributions</b>");
    expect(out).toContain("avg=9  min=1 max=100");
    expect(out).not.toContain("min=1ms");
  });

  it("sorts the tool_calls group by count, busiest first", () => {
    const messages = renderMetricsMessages({
      counters: {
        "tool_calls.Read": 3,
        "tool_calls.Bash": 162,
        "tool_calls.end_turn": 16,
        "backend.claude.queries": 3,
        "backend.codex.queries": 18,
      },
      histograms: {},
    });

    const out = messages.join("\n");
    const bash = out.indexOf(">Bash<");
    const endTurn = out.indexOf(">end_turn<");
    const read = out.indexOf(">Read<");
    expect(bash).toBeGreaterThan(-1);
    expect(bash).toBeLessThan(endTurn);
    expect(endTurn).toBeLessThan(read);
    // Other groups stay alphabetical.
    expect(out.indexOf("claude.queries")).toBeLessThan(
      out.indexOf("codex.queries"),
    );
  });

  it("splits large metrics output into Telegram-safe chunks", () => {
    const counters = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`tool_calls.tool_${i}`, i + 1]),
    );

    const messages = renderMetricsMessages({ counters, histograms: {} }, 160);

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(160);
    }
    expect(messages[0]).toContain("<b>📊 Metrics</b>");
    expect(
      messages.slice(1).every((message) => message.includes("(cont.)")),
    ).toBe(true);
  });

  it("shows an empty-state message when no metrics exist", () => {
    expect(renderMetricsMessages({ counters: {}, histograms: {} })).toEqual([
      "<b>📊 Metrics</b>\n\n<i>No metrics recorded yet.</i>",
    ]);
  });
});
