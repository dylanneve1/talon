/**
 * Shared types for the modular tool system.
 *
 * Tool definitions are pure data + execute logic — no MCP imports,
 * no bridge coupling.  The MCP server consumes these via composeTools().
 */

import type { ZodRawShape } from "zod";

/** Which frontends a tool is available on.  "all" = every frontend. */
export type ToolFrontend = "telegram" | "teams" | "terminal" | "all";

/** Domain tags for runtime filtering and grouping. */
export type ToolTag =
  | "messaging"
  | "chat"
  | "history"
  | "members"
  | "media"
  | "stickers"
  | "scheduling"
  | "web"
  | "admin";

/** The bridge caller signature — injected into execute(). */
export type BridgeFunction = (
  action: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * A self-contained tool definition.
 *
 * Contains everything needed to register it with an MCP server
 * AND to know which bridge action it maps to.
 */
export interface ToolDefinition {
  /** MCP tool name (e.g. "send", "react", "fetch_url"). */
  readonly name: string;

  /** Human-readable description shown to the model. */
  readonly description: string;

  /** Zod schema shape for the tool's input parameters. */
  readonly schema: ZodRawShape;

  /**
   * Execute the tool.  Receives validated params and a bridge caller.
   * Returns the raw bridge result (wrapped by the MCP layer).
   */
  readonly execute: (
    params: Record<string, unknown>,
    bridge: BridgeFunction,
  ) => Promise<unknown>;

  /** Which frontends this tool appears on. Omit for all frontends. */
  readonly frontends?: readonly ToolFrontend[];

  /** Grouping tag. */
  readonly tag: ToolTag;
}
