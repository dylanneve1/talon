/**
 * Component-handler types.
 *
 * The router (index.ts) keys `ComponentHandlers` by the custom-id prefix —
 * the first `:`-terminated segment (`settings:`, `pulse:`, `model:`, …).
 * A handler owns everything under its prefix and returns `false` for an id
 * it doesn't recognise, so the router can ack it the way it acks an id with
 * no handler at all (stale buttons from older panels).
 */

import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import type { TalonConfig } from "../../../../core/config/index.js";
import type { Gateway } from "../../../../core/engine/gateway.js";

export type ComponentInteraction =
  ButtonInteraction | StringSelectMenuInteraction;

export interface ComponentContext {
  config: TalonConfig;
  gateway: Gateway;
  /** Talon chat id (`discord_guild_…` / `discord_dm_…`), already registered. */
  chatId: string;
  numericChatId: number;
}

type ComponentHandler = (
  interaction: ComponentInteraction,
  context: ComponentContext,
) => Promise<boolean>;

export type ComponentHandlers = Record<string, ComponentHandler>;
