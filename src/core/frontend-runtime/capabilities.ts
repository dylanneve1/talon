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
import type { TalonConfig } from "../config/index.js";
import type { Gateway } from "../engine/gateway.js";
import type { FrontendDescriptor } from "./registry.js";

/**
 * The runtime interface every frontend implements (moved here from
 * `bootstrap.ts`; `bootstrap.ts` re-exports it for existing importers).
 * Lifecycle: `create → init → start → stop`.
 *
 * `start()` resolves at STARTED, never at STOPPED. A frontend that kept
 * its run-until-stopped loop as the `start()` promise made the boot end
 * at shutdown: boot metrics, the resource sampler and the "Ready in …"
 * line all fired hours late, and anything the composition root
 * sequenced after the await never ran while the daemon was alive.
 */
export type Frontend = {
  /** Registry id of the frontend that created this instance. */
  name: string;
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  /**
   * Bring the surface up and resolve once it is LISTENING: bot identity
   * fetched and polling running, socket connecting, server bound, prompt
   * loop drawn. A frontend with a run-until-stopped loop (long-poll,
   * reconnect loop) keeps that promise internally — see
   * `runUntilStopped` in `run-loop.ts` — and awaits it in `stop()`.
   * Rejecting means the frontend never came up; the boot fails loudly.
   */
  start: () => Promise<void>;
  /**
   * Take the surface down and resolve once it is fully stopped,
   * including the run loop `start()` left running.
   */
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
