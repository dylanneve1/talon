/**
 * VFS resolver — the mount table and the address grammar.
 *
 * The resolver owns everything mounts shouldn't have to repeat: address
 * parsing, normalization, traversal rejection, routing to the mount, and
 * re-prefixing the mount-relative stats that come back. Mounts therefore
 * only ever see clean relative paths.
 *
 * An address is one of exactly two spellings of the same node:
 *
 *   talon://home/notes.md   scheme form — always namespace-interpreted
 *   <workspace>/notes.md    OS-absolute form — routed through the mount
 *                           table by containment, exactly like a kernel
 *                           resolving a path through its mounts
 *
 * Nothing else is an address. Bare relative paths and `~` spellings are
 * refused with the correction rather than guessed at — the old
 * mount-relative form (`home/notes.md`) was ambiguous with a relative OS
 * path and is gone. The empty string (and bare separators) still name the
 * namespace root for internal callers.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { VfsMount, VfsResult, VfsStat } from "./types.js";
import { vfsError, vfsOk } from "./types.js";

const SCHEME = "talon://";

/** OS-absolute spellings: `/x`, `\\server\x`, `C:\x`, `C:/x`. */
const OS_ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** A parsed path: which mount, and the path inside it. */
type Resolved = { mount: VfsMount; prefix: string; rel: string };

export class Vfs {
  readonly #mounts = new Map<string, VfsMount>();

  /** Register a mount under a single-segment name ("skills", "proc"). */
  mount(name: string, mount: VfsMount): void {
    if (!/^[a-z0-9-]+$/.test(name)) {
      throw new Error(`Invalid mount name: "${name}"`);
    }
    if (this.#mounts.has(name)) {
      throw new Error(`Mount "${name}" already registered`);
    }
    this.#mounts.set(name, mount);
  }

  stat(path: string): VfsResult<VfsStat> {
    const parsed = this.#parse(path);
    if (!parsed.ok) return parsed;
    if (parsed.value === null) {
      return vfsOk({
        path: "",
        name: SCHEME,
        kind: "dir" as const,
        writable: false,
      });
    }
    const { mount, prefix, rel } = parsed.value;
    const result = mount.stat(rel);
    return result.ok ? vfsOk(withPrefix(result.value, prefix)) : result;
  }

  list(path: string): VfsResult<VfsStat[]> {
    const parsed = this.#parse(path);
    if (!parsed.ok) return parsed;
    if (parsed.value === null) {
      return vfsOk(
        [...this.#mounts.entries()].map(([name, mount]) => ({
          path: name,
          name,
          kind: "dir" as const,
          writable: mount.writable,
          ...(mount.osRoot !== undefined ? { osPath: mount.osRoot } : {}),
        })),
      );
    }
    const { mount, prefix, rel } = parsed.value;
    const result = mount.list(rel);
    return result.ok
      ? vfsOk(result.value.map((entry) => withPrefix(entry, prefix)))
      : result;
  }

  read(path: string): VfsResult<string> {
    const parsed = this.#parse(path);
    if (!parsed.ok) return parsed;
    if (parsed.value === null) return vfsError("is-a-directory");
    return parsed.value.mount.read(parsed.value.rel);
  }

  write(path: string, content: string): VfsResult<VfsStat> {
    const parsed = this.#parse(path);
    if (!parsed.ok) return parsed;
    if (parsed.value === null) return vfsError("is-a-directory");
    const { mount, prefix, rel } = parsed.value;
    if (!mount.write) {
      return vfsError("not-writable", `talon://${prefix} is read-only`);
    }
    const result = mount.write(rel, content);
    return result.ok ? vfsOk(withPrefix(result.value, prefix)) : result;
  }

  /**
   * The mount table as data: name, description, writability, and — for
   * file-backed mounts — the disk root. Consumed by the namespace dir
   * builder (symlink farm), the FUSE layer, and docs/tool output.
   */
  describeMounts(): {
    name: string;
    description: string;
    writable: boolean;
    osRoot?: string;
  }[] {
    return [...this.#mounts.entries()].map(([name, mount]) => ({
      name,
      description: mount.description,
      writable: mount.writable,
      ...(mount.osRoot !== undefined ? { osRoot: mount.osRoot } : {}),
    }));
  }

  /** null = the namespace root. */
  #parse(raw: string): VfsResult<Resolved | null> {
    let path = raw.trim();
    if (path.startsWith(SCHEME)) {
      path = path.slice(SCHEME.length);
    } else if (path === "" || /^[\\/]+$/.test(path)) {
      // Internal callers address the namespace root as "" or bare separators.
      return vfsOk(null);
    } else if (OS_ABSOLUTE.test(path)) {
      return this.#parseOsPath(path);
    } else if (path.startsWith("talon:")) {
      // A near-miss scheme (talon:/x, talon:x) is always a typo, never a path.
      return vfsError(
        "invalid-path",
        `Did you mean "${SCHEME}${path.replace(/^talon:\/{0,2}/, "")}"?`,
      );
    } else {
      return vfsError(
        "invalid-path",
        `Not an address — use ${SCHEME}<mount>/… or an absolute OS path`,
      );
    }
    if (path.includes("\\")) {
      return vfsError(
        "invalid-path",
        "Namespace paths use / on every platform",
      );
    }
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.some((s) => s === "." || s === "..")) {
      return vfsError("invalid-path", "Relative segments are not allowed");
    }
    if (segments.length === 0) return vfsOk(null);

    const [head, ...rest] = segments;
    const mount = this.#mounts.get(head!);
    if (!mount) {
      return vfsError(
        "not-found",
        `No mount "${head}" — the root lists what exists`,
      );
    }
    return vfsOk({ mount, prefix: head!, rel: rest.join("/") });
  }

  /**
   * Route an OS-absolute address through the mount table by containment —
   * the most specific (longest) disk root wins, so a mount nested inside
   * another's root (skills/ inside the workspace) claims its own subtree.
   * Outside every mount there is nothing to address: refuse with the mount
   * table rather than guess.
   */
  #parseOsPath(osPath: string): VfsResult<Resolved> {
    // isAbsolute guards the host boundary: a foreign spelling (a drive path
    // on POSIX) can't be resolved against this host's roots.
    if (isAbsolute(osPath)) {
      const abs = resolve(osPath);
      let best: (Resolved & { rootLength: number }) | undefined;
      for (const [name, mount] of this.#mounts) {
        if (mount.osRoot === undefined) continue;
        const offset = relative(mount.osRoot, abs);
        if (
          offset === ".." ||
          offset.startsWith(`..${sep}`) ||
          isAbsolute(offset)
        ) {
          continue;
        }
        if (best !== undefined && mount.osRoot.length <= best.rootLength) {
          continue;
        }
        best = {
          mount,
          prefix: name,
          rel: offset
            .split(sep)
            .filter((s) => s.length > 0)
            .join("/"),
          rootLength: mount.osRoot.length,
        };
      }
      if (best !== undefined) {
        return vfsOk({ mount: best.mount, prefix: best.prefix, rel: best.rel });
      }
    }
    const respelled = osPath
      .split(/[\\/]+/)
      .filter((s) => s.length > 0 && !/^[A-Za-z]:$/.test(s));
    if (respelled[0] !== undefined && this.#mounts.has(respelled[0])) {
      return vfsError(
        "not-found",
        `OS paths resolve only inside a mounted directory — did you mean "talon://${respelled.join("/")}"?`,
      );
    }
    const roots = [...this.#mounts.entries()]
      .filter(([, mount]) => mount.osRoot !== undefined)
      .map(([name, mount]) => `${name} → ${mount.osRoot}`);
    return vfsError(
      "not-found",
      roots.length > 0
        ? `Not inside any mounted directory. Mounts on disk: ${roots.join(", ")}`
        : "Not inside any mounted directory",
    );
  }
}

function withPrefix(stat: VfsStat, prefix: string): VfsStat {
  const path = stat.path === "" ? prefix : `${prefix}/${stat.path}`;
  return { ...stat, path, name: stat.path === "" ? prefix : stat.name };
}
