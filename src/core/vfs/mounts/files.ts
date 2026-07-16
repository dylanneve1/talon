/**
 * File mount — a real directory exposed into the namespace.
 *
 * Backs the workspace-shaped mounts (home, skills, scripts, logs). The
 * resolver has already rejected traversal segments; the containment check
 * here is belt-and-braces so no future caller can reach outside the root.
 * A missing root reads as an empty directory — mounts exist from boot,
 * the workspace dirs appear lazily.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { VfsMount, VfsResult, VfsStat } from "../types.js";
import { VFS_MAX_READ_BYTES, vfsError, vfsOk } from "../types.js";

export function createFileMount(options: {
  root: string;
  description: string;
  writable: boolean;
}): VfsMount {
  const root = resolve(options.root);

  /** Absolute path for `rel`, or undefined when it would escape the root. */
  function realPath(rel: string): string | undefined {
    const abs = resolve(root, ...rel.split("/"));
    const offset = relative(root, abs);
    if (
      offset.startsWith(`..${sep}`) ||
      offset === ".." ||
      isAbsolute(offset)
    ) {
      return undefined;
    }
    return abs;
  }

  function statAt(rel: string, abs: string): VfsResult<VfsStat> {
    try {
      const stats = statSync(abs);
      const name = rel === "" ? "" : rel.split("/").at(-1)!;
      return vfsOk({
        path: rel,
        name,
        kind: stats.isDirectory() ? ("dir" as const) : ("file" as const),
        ...(stats.isFile() ? { size: stats.size } : {}),
        modifiedAt: Math.floor(stats.mtimeMs),
        writable: options.writable,
        osPath: abs,
      });
    } catch {
      return vfsError("not-found");
    }
  }

  return {
    description: options.description,
    writable: options.writable,
    osRoot: root,

    stat(rel) {
      const abs = realPath(rel);
      if (!abs) return vfsError("invalid-path");
      if (rel === "" && !existsSync(abs)) {
        return vfsOk({
          path: "",
          name: "",
          kind: "dir",
          writable: options.writable,
          osPath: abs,
        });
      }
      return statAt(rel, abs);
    },

    list(rel) {
      const abs = realPath(rel);
      if (!abs) return vfsError("invalid-path");
      if (rel === "" && !existsSync(abs)) return vfsOk([]);
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        return vfsError("not-found");
      }
      if (!stats.isDirectory()) return vfsError("not-a-directory");
      const entries = readdirSync(abs, { withFileTypes: true })
        .map((entry) => {
          const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
          const child = statAt(childRel, resolve(abs, entry.name));
          return child.ok ? child.value : undefined;
        })
        .filter((entry): entry is VfsStat => entry !== undefined)
        .sort(
          (a, b) =>
            Number(a.kind === "file") - Number(b.kind === "file") ||
            a.name.localeCompare(b.name),
        );
      return vfsOk(entries);
    },

    read(rel) {
      const abs = realPath(rel);
      if (!abs) return vfsError("invalid-path");
      let stats;
      try {
        stats = statSync(abs);
      } catch {
        return vfsError("not-found");
      }
      if (stats.isDirectory()) return vfsError("is-a-directory");
      if (stats.size > VFS_MAX_READ_BYTES) {
        return vfsError(
          "too-large",
          `${stats.size} bytes (cap ${VFS_MAX_READ_BYTES}) — on disk at ${abs}`,
        );
      }
      const buffer = readFileSync(abs);
      if (buffer.includes(0)) {
        return vfsError("binary-file", "Content contains null bytes");
      }
      return vfsOk(buffer.toString("utf-8"));
    },

    ...(options.writable
      ? {
          write(rel: string, content: string): VfsResult<VfsStat> {
            if (rel === "") return vfsError("is-a-directory");
            const abs = realPath(rel);
            if (!abs) return vfsError("invalid-path");
            if (existsSync(abs) && statSync(abs).isDirectory()) {
              return vfsError("is-a-directory");
            }
            try {
              mkdirSync(dirname(abs), { recursive: true });
              writeFileSync(abs, content, "utf-8");
            } catch (err) {
              return vfsError(
                "io-error",
                err instanceof Error ? err.message : String(err),
              );
            }
            return statAt(rel, abs);
          },
        }
      : {}),
  };
}
