import { beforeEach, describe, expect, it } from "vitest";
import { clearModels, registerModels } from "../core/models.js";
import {
  formatCompactModelLabel,
  formatModelLabel,
  formatModelOptionLabel,
  getTelegramModelOptions,
  isSelectedModel,
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
        capabilities: {
          supports1mContext: true,
          oneMillionContextModelId: "sonnet[1m]",
        },
        tier: "balanced",
        fallback: "haiku",
      },
      {
        id: "sonnet[1m]",
        displayName: "Sonnet (1M context)",
        description:
          "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok",
        aliases: ["claude-sonnet-4-6[1m]"],
        provider: "anthropic",
        capabilities: { supports1mContext: true },
        tier: "balanced",
        fallback: "haiku",
      },
      {
        id: "opus",
        displayName: "Opus",
        description: "Opus 4.6 · Most capable for complex work",
        aliases: ["claude-opus-4-6"],
        provider: "anthropic",
        capabilities: {
          supports1mContext: true,
          oneMillionContextModelId: "opus[1m]",
        },
        tier: "premium",
        fallback: "default",
      },
      {
        id: "opus[1m]",
        displayName: "Opus (1M context)",
        description:
          "Opus 4.6 with 1M context · Billed as extra usage · $5/$25 per Mtok",
        aliases: ["claude-opus-4-6[1m]"],
        provider: "anthropic",
        capabilities: { supports1mContext: true },
        tier: "premium",
        fallback: "default",
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
        aliases: ["claude-haiku-4-5"],
        provider: "anthropic",
        capabilities: { supports1mContext: false },
        tier: "economy",
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
      "Opus 4.6",
    );
    expect(formatCompactModelLabel(getTelegramModelOptions()[1]!)).toBe(
      "Sonnet",
    );
  });

  it("shows a single clean option per model family", () => {
    expect(getTelegramModelOptions().map((model) => model.id)).toEqual([
      "opus",
      "default",
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

    expect(buttons).toContain("\u2713 Sonnet");
  });
});
