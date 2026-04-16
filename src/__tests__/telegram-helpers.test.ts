import { beforeEach, describe, expect, it } from "vitest";
import { clearModels, registerModels } from "../core/models.js";
import {
  formatCompactModelLabel,
  formatDuration,
  formatModelLabel,
  formatModelOptionLabel,
  getTelegramModelOptions,
  isSelectedModel,
  renderMetricsMessages,
  renderSettingsKeyboard,
} from "../frontend/telegram/helpers.js";

describe("telegram helpers", () => {
  beforeEach(() => {
    clearModels();
    registerModels([
      {
        id: "default",
        displayName: "Default (recommended)",
        description: "Sonnet 4.6 · Best for everyday tasks",
        aliases: ["sonnet", "claude-sonnet-4-6"],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description:
          "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok",
        aliases: ["claude-sonnet-4-6[1m]"],
        provider: "anthropic",
        fallback: "haiku",
      },
      {
        id: "opus",
        displayName: "Opus",
        description: "Opus 4.6 · Most capable for complex work",
        aliases: ["claude-opus-4-6"],
        provider: "anthropic",
        fallback: "default",
      },
      {
        id: "opus[1m]",
        displayName: "Opus (1M context)",
        description:
          "Opus 4.6 with 1M context · Billed as extra usage · $5/$25 per Mtok",
        aliases: ["claude-opus-4-6[1m]"],
        provider: "anthropic",
        fallback: "default",
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
        aliases: ["claude-haiku-4-5"],
        provider: "anthropic",
      },
    ]);
  });

  it("matches legacy aliases to the canonical selected model", () => {
    expect(isSelectedModel("claude-sonnet-4-6", "default")).toBe(true);
    expect(isSelectedModel("sonnet[1m]", "default")).toBe(true);
    expect(isSelectedModel("claude-sonnet-4-6", "haiku")).toBe(false);
  });

  it("formats clean model labels for telegram users", () => {
    expect(formatModelLabel("default")).toBe("Sonnet 4.6");
    expect(formatModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(formatModelLabel("sonnet[1m]")).toBe("Sonnet 4.6");
    expect(formatModelOptionLabel(getTelegramModelOptions()[0]!)).toBe(
      "Sonnet 4.6",
    );
    expect(formatCompactModelLabel(getTelegramModelOptions()[1]!)).toBe(
      "Opus 4.6",
    );
  });

  it("shows a single clean option per model family", () => {
    expect(getTelegramModelOptions().map((model) => model.id)).toEqual([
      "default",
      "opus",
      "haiku",
    ]);
  });

  it("marks the canonical model button as selected for legacy aliases", () => {
    const buttons = renderSettingsKeyboard(
      "claude-sonnet-4-6",
      "adaptive",
      true,
    )
      .flat()
      .map((button) => button.text);

    expect(buttons).toContain("\u2713 Sonnet 4.6");
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

describe("renderMetricsMessages", () => {
  it("formats latency metrics with millisecond precision", () => {
    const messages = renderMetricsMessages({
      counters: { queries_total: 7 },
      histograms: {
        response_latency_ms: {
          count: 3,
          p50: 250,
          p95: 1_250,
          p99: 2_000,
          avg: 900,
        },
      },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("p50=250ms");
    expect(messages[0]).toContain("p95=1s");
    expect(messages[0]).toContain("avg=900ms");
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
