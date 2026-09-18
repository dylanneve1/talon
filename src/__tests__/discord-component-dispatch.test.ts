/**
 * Discord component router — the custom-id prefix table.
 *
 * Pins the routing contract the if/switch chain used to carry implicitly:
 * each prefix reaches its own handler, an id nobody claims (unknown prefix,
 * no colon, an Object.prototype name, a handler declining) is logged and
 * silently acked, and the access gate runs before any of it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MessageFlags } from "discord.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

const handlers = vi.hoisted(() => ({
  settings: vi.fn(async () => true),
  pulse: vi.fn(async () => true),
  effort: vi.fn(async () => true),
  model: vi.fn(async () => true),
  metrics: vi.fn(async () => true),
  ai: vi.fn(async () => true),
}));
vi.mock("../frontend/discord/callbacks/components/settings.js", () => ({
  handleSettingsComponent: handlers.settings,
}));
vi.mock("../frontend/discord/callbacks/components/pulse.js", () => ({
  handlePulseComponent: handlers.pulse,
}));
vi.mock("../frontend/discord/callbacks/components/effort.js", () => ({
  handleEffortComponent: handlers.effort,
}));
vi.mock("../frontend/discord/callbacks/components/model.js", () => ({
  handleModelComponent: handlers.model,
}));
vi.mock("../frontend/discord/callbacks/components/metrics.js", () => ({
  handleMetricsComponent: handlers.metrics,
}));
vi.mock("../frontend/discord/callbacks/components/agent-buttons.js", () => ({
  forwardToAgent: handlers.ai,
}));

import {
  COMPONENT_HANDLERS,
  componentRouteKey,
  handleComponentInteraction,
} from "../frontend/discord/callbacks/components/index.js";
import type { ComponentInteraction } from "../frontend/discord/callbacks/components/types.js";
import { setAccessControl } from "../frontend/discord/handlers/index.js";
import { deriveNumericChatId } from "../core/frontend-runtime/chat-id.js";
import { logError } from "../util/log.js";
import type { TalonConfig } from "../core/config/index.js";
import type { Gateway } from "../core/engine/gateway.js";

const config = {} as TalonConfig;
const gateway = {} as Gateway;

type Fake = ComponentInteraction & {
  reply: ReturnType<typeof vi.fn>;
  deferUpdate: ReturnType<typeof vi.fn>;
};

function dmInteraction(customId: string, userId = "u1"): Fake {
  return {
    customId,
    inGuild: () => false,
    user: { id: userId, username: "someone" },
    guildId: null,
    channelId: "dm-1",
    member: null,
    isButton: () => true,
    isStringSelectMenu: () => false,
    reply: vi.fn(async () => undefined),
    deferUpdate: vi.fn(async () => undefined),
  } as unknown as Fake;
}

const allHandlers = Object.values(handlers);

beforeEach(() => {
  vi.clearAllMocks();
  setAccessControl({
    allowedUsers: ["u1"],
    allowedGuilds: [],
    allowedChannels: [],
    adminUserIds: [],
    respondMode: "mention",
  });
});

async function expectUnknownAck(interaction: Fake): Promise<void> {
  await handleComponentInteraction(interaction, config, gateway);
  for (const h of allHandlers) expect(h).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalledWith(
    "discord",
    `Unknown custom_id: ${interaction.customId}`,
  );
  expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
  expect(interaction.reply).not.toHaveBeenCalled();
}

describe("componentRouteKey", () => {
  it("is the first segment, colon included; no colon keys to nothing", () => {
    expect(componentRouteKey("settings:done")).toBe("settings:");
    expect(componentRouteKey("model:nav:2:all")).toBe("model:");
    expect(componentRouteKey("ai:pick:one")).toBe("ai:");
    expect(componentRouteKey("settings")).toBe("");
    expect(componentRouteKey("")).toBe("");
  });
});

describe("COMPONENT_HANDLERS", () => {
  it("has a null prototype and exactly the documented prefixes", () => {
    expect(Object.getPrototypeOf(COMPONENT_HANDLERS)).toBeNull();
    expect(Object.keys(COMPONENT_HANDLERS).sort()).toEqual([
      "ai:",
      "effort:",
      "metrics:",
      "model:",
      "pulse:",
      "settings:",
    ]);
  });
});

describe("handleComponentInteraction", () => {
  it.each([
    ["settings:done", handlers.settings],
    ["pulse:on", handlers.pulse],
    ["effort:select", handlers.effort],
    ["model:nav:2:all", handlers.model],
    ["metrics:all", handlers.metrics],
    ["ai:whatever:the:model:sent", handlers.ai],
  ])("routes %s to its prefix handler", async (customId, handler) => {
    const interaction = dmInteraction(customId);
    await handleComponentInteraction(interaction, config, gateway);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(interaction, {
      config,
      gateway,
      chatId: "discord_dm_u1",
      numericChatId: deriveNumericChatId("discord_dm_u1"),
    });
    for (const other of allHandlers) {
      if (other !== handler) expect(other).not.toHaveBeenCalled();
    }
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("acks an unknown prefix silently and logs it", async () => {
    await expectUnknownAck(dmInteraction("nope:thing"));
  });

  it("treats an id without a colon as unknown", async () => {
    await expectUnknownAck(dmInteraction("settings"));
  });

  it("does not resolve Object.prototype names as handlers", async () => {
    await expectUnknownAck(dmInteraction("constructor:x"));
    vi.clearAllMocks();
    await expectUnknownAck(dmInteraction("toString:x"));
  });

  it("falls back the same way when a prefix handler declines the id", async () => {
    handlers.effort.mockResolvedValueOnce(false);
    const interaction = dmInteraction("effort:stale");
    await handleComponentInteraction(interaction, config, gateway);
    expect(handlers.effort).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(
      "discord",
      "Unknown custom_id: effort:stale",
    );
    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
  });

  it("gates on access before touching the table", async () => {
    const interaction = dmInteraction("settings:done", "stranger");
    await handleComponentInteraction(interaction, config, gateway);
    for (const h of allHandlers) expect(h).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "⚠️ DM access not authorized.",
      flags: MessageFlags.Ephemeral,
    });
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });
});
