/**
 * Frontend capability contract — the frontend counterpart of
 * `core/agent-runtime/capabilities.ts`.
 *
 * A frontend is a chat surface (Telegram, Discord, Teams, the terminal,
 * the native client bridge, …) that receives user messages and delivers
 * the agent's replies. Every frontend implements the same `Frontend`
 * runtime interface and describes itself with a `FrontendDescriptor` in
 * the frontend registry (`registry.ts`), so the engine can create, route
 * to, and reason about frontends without knowing any concrete one.
 *
 * The contract is split in two on purpose:
 *
 *   - `FrontendDescriptor` (defined in `registry.ts`) — cheap, static
 *     identity: id, label, chat-id ownership, routing traits.
 *     Descriptors for the built-ins register from core (`builtins.ts`)
 *     so every subsystem that only needs "whose chat id is this?"
 *     (gateway routing, MCP tool scoping, dispatcher context) can
 *     consult the registry without loading any frontend implementation.
 *   - `FrontendCreate` — the heavy part. Attached separately by each
 *     frontend's `factory.ts` (frontend layer), which dynamically
 *     imports the implementation only when that frontend is actually
 *     configured. Plugin frontends register a descriptor and create
 *     function together at runtime (`registerFrontend` in `create.ts`).
 */

import type { ContextManager } from "../types.js";
import type { TalonConfig } from "../../util/config.js";
import type { Gateway } from "../engine/gateway.js";
import type { FrontendDescriptor } from "./registry.js";

/**
 * The runtime interface every frontend implements (moved here from
 * `bootstrap.ts`; `bootstrap.ts` re-exports it for existing importers).
 * Lifecycle: `create → init → start → stop`.
 */
export type Frontend = {
  /** Registry id of the frontend that created this instance. */
  name: string;
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * Creates the runtime instance for a frontend. Implementations should
 * dynamically import their heavy dependencies here so an unconfigured
 * frontend costs nothing at boot.
 */
export type FrontendCreate = (
  config: TalonConfig,
  gateway: Gateway,
) => Frontend | Promise<Frontend>;

/** A fully-registered frontend: identity plus the factory. */
export type FrontendFactory = FrontendDescriptor & { create: FrontendCreate };

export type { FrontendDescriptor } from "./registry.js";
