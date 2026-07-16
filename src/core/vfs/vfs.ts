/**
 * VFS resolver — the mount table and the path discipline.
 *
 * The resolver owns everything mounts shouldn't have to repeat: scheme
 * stripping, normalization, traversal rejection, routing to the mount by
 * first segment, and re-prefixing the mount-relative stats that come back.
 * Mounts therefore only ever see clean relative paths.
 */

import type { VfsMount, VfsResult, VfsStat } from "./types.js";
import { vfsError, vfsOk } from "./types.js";

const SCHEME = "talon://";

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

  /** Mount names + descriptions, for docs/tool output. */
  describeMounts(): { name: string; description: string; writable: boolean }[] {
    return [...this.#mounts.entries()].map(([name, mount]) => ({
      name,
      description: mount.description,
      writable: mount.writable,
    }));
  }

  /** null = the namespace root. */
  #parse(raw: string): VfsResult<Resolved | null> {
    let path = raw.trim();
    if (path.startsWith(SCHEME)) path = path.slice(SCHEME.length);
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
}

function withPrefix(stat: VfsStat, prefix: string): VfsStat {
  const path = stat.path === "" ? prefix : `${prefix}/${stat.path}`;
  return { ...stat, path, name: stat.path === "" ? prefix : stat.name };
}
