/**
 * Remote-agent client surface used by the shared MCP / session / provider
 * helpers. Both `@opencode-ai/sdk`'s `OpencodeClient` and `@kilocode/sdk`'s
 * `KiloClient` structurally satisfy this interface for the API surface
 * Talon depends on.
 *
 * The interface is deliberately narrow — only the methods the SHARED code
 * paths call. Backend-specific code (Kilo SSE streaming, OpenCode sync
 * prompt) keeps using the concrete client types from each SDK.
 *
 * Why: the upstream OpenCode and Kilo agent servers expose the same HTTP
 * API for MCP registration, session lifecycle, tool listing, and provider
 * resolution. Their SDKs declare distinct nominal types, but the shapes
 * line up byte-for-byte (Kilo is a fork of OpenCode). Sharing the helpers
 * via a structural interface lets us write one implementation of the
 * "register the Talon chat MCP server" / "create a session with
 * permission rules" / "walk the provider catalog" logic — instead of
 * keeping two copies that drift the moment one side gets a fix the other
 * doesn't.
 */

/** Minimal MCP server config shapes both SDKs accept on `mcp.add`. */
export type RemoteMcpServerConfig =
  | {
      type: "local";
      command: string[];
      environment?: Record<string, string>;
    }
  | {
      type: "remote";
      /** Streamable-HTTP MCP endpoint (Talon's hub). */
      url: string;
      headers?: Record<string, string>;
    };

/** Permission-rule shape both SDKs share. */
export interface RemotePermissionRule {
  permission: "tool" | "edit" | "bash" | "external_directory";
  pattern: string;
  action: "allow" | "deny" | "ask";
}

/**
 * Narrow client interface used by the shared helpers. Both
 * `OpencodeClient` and `KiloClient` structurally satisfy this — the
 * shared code is written against the interface and either concrete
 * client can be passed in.
 */
export interface RemoteAgentClient {
  mcp: {
    add(args: {
      name: string;
      config: RemoteMcpServerConfig;
    }): Promise<unknown>;
    disconnect(args: { name: string }): Promise<unknown>;
  };
  session: {
    create(args: {
      title: string;
      permission: RemotePermissionRule[];
    }): Promise<{ data?: unknown }>;
    get(args: { sessionID: string }): Promise<unknown>;
  };
  tool: {
    ids(): Promise<{ data?: unknown }>;
  };
  provider: {
    list(): Promise<{ data?: unknown }>;
  };
}
