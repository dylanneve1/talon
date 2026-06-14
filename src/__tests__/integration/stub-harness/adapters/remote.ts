/**
 * Remote-server stub adapter — covers **opencode** and **kilo** (a fork with
 * the same HTTP wire API). Both backends adopt any server already listening on
 * their port env (`OPENCODE_PORT` / `KILO_PORT`) by probing `/global/health`,
 * so the adapter starts the in-process fake on a DYNAMIC port and assigns it
 * into the env before the composition root imports the backend module.
 */
import type { TalonConfig } from "../../../../util/config.js";
import type { StubBackendAdapter } from "../types.js";
import {
  startFakeRemoteServer,
  type FakeRemoteServer,
  type RemoteTurn,
} from "../../stub-remote/fake-remote-server.js";

export interface RemoteAdapterOptions {
  id: "opencode" | "kilo";
  /** The env var the backend reads its base-URL port from. */
  portEnv: "OPENCODE_PORT" | "KILO_PORT";
  /** Model id the fake `/provider` catalog advertises. Defaults to `stub-model`. */
  model?: string;
}

export function remoteAdapter(
  opts: RemoteAdapterOptions,
): StubBackendAdapter<RemoteTurn> {
  let server: FakeRemoteServer | null = null;

  return {
    id: opts.id as TalonConfig["backend"],
    model: opts.model ?? "stub-model",

    async prepare() {
      // Dynamic port (0 → OS-assigned) → no fixed-port collisions, no
      // vi.hoisted. Assign it into the env BEFORE the backend module evaluates
      // its `${PORT}` const (which happens inside initBackendAndDispatcher).
      server = await startFakeRemoteServer(0);
      process.env[opts.portEnv] = String(server.port);
    },

    applyTurn(turn) {
      if (!server) throw new Error("remote adapter: server not started");
      server.setTurn(turn);
    },

    collectExtras() {
      return { mcpRegistrations: server?.mcpRegistrations() ?? [] };
    },

    async teardown() {
      await server?.stop();
      server = null;
    },
  };
}
