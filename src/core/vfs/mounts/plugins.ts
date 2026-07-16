/**
 * Plugins mount — the plugin registry as a synthetic read-only directory:
 * one file per loaded plugin (or registered standalone MCP entry), whose
 * content is the registry's view of it as pretty JSON. Provider-injected
 * like proc — the index wires the live registry, tests wire fixtures.
 */

import type { VfsMount, VfsResult, VfsStat } from "../types.js";
import { vfsError, vfsOk } from "../types.js";

/** The registry facts one plugin file exposes. */
export interface PluginView {
  readonly name: string;
  readonly kind: "module" | "mcp";
  readonly description?: string;
  readonly version?: string;
  /** Module path, or the MCP entry's command line. */
  readonly source: string;
}

function render(view: PluginView): string {
  return `${JSON.stringify(view, null, 2)}\n`;
}

function fileStat(view: PluginView): VfsStat {
  return {
    path: view.name,
    name: view.name,
    kind: "file",
    size: Buffer.byteLength(render(view), "utf-8"),
    writable: false,
  };
}

export function createPluginsMount(
  plugins: () => readonly PluginView[],
): VfsMount {
  function byName(rel: string): PluginView | undefined {
    return plugins().find((view) => view.name === rel);
  }

  return {
    description: "Loaded plugins and registered MCP servers (registry view)",
    writable: false,

    stat(rel): VfsResult<VfsStat> {
      if (rel === "")
        return vfsOk({ path: "", name: "", kind: "dir", writable: false });
      const view = byName(rel);
      return view ? vfsOk(fileStat(view)) : vfsError("not-found");
    },

    list(rel) {
      if (rel !== "") {
        return byName(rel)
          ? vfsError("not-a-directory")
          : vfsError("not-found");
      }
      return vfsOk(
        plugins()
          .map(fileStat)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    },

    read(rel) {
      if (rel === "") return vfsError("is-a-directory");
      const view = byName(rel);
      return view ? vfsOk(render(view)) : vfsError("not-found");
    },
  };
}
