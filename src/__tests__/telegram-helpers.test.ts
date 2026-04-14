import { beforeEach, describe, expect, it } from "vitest";
import { clearModels, registerModels } from "../core/models.js";
import {
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
    expect(isSelectedModel("claude-sonnet-4-6", "haiku")).toBe(false);
  });

  it("marks the canonical model button as selected for legacy aliases", () => {
    const buttons = renderSettingsKeyboard("claude-sonnet-4-6", "adaptive", true)
      .flat()
      .map((button) => button.text);

    expect(buttons).toContain("\u2713 Default");
  });
});
