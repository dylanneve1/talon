/**
 * VFS vocabulary — the unified `talon://` namespace.
 *
 * One rooted, mountable namespace over everything the daemon owns, in the
 * Plan 9 tradition: real-file stores (workspace, skills, scripts, logs)
 * and synthetic /proc-style views of live state (task table, event bus,
 * plugin registry) answer the same four operations. The namespace is for
 * unification and introspection — mounts decide what they can do (a
 * synthetic view has nothing meaningful to write), but the VFS is never a
 * permission layer.
 *
 * An address reaches the namespace in one of three spellings, all resolved
 * by the same grammar (see `Vfs.#parse`):
 *
 *   - scheme:         `talon://skills/review-pr/SKILL.md`
 *   - mount-relative: `skills/review-pr/SKILL.md` (`/`-separated everywhere)
 *   - OS-absolute:    the disk spelling of a node inside a file-backed
 *                     mount's root — the same node, other coordinate system
 *
 * Mounts receive mount-relative paths ("" = the mount root) and report
 * entry paths mount-relative too — the resolver owns prefixing.
 */

/** What a path points at. */
export type VfsNodeKind = "dir" | "file";

/** Errno-style failure vocabulary — every operation fails with one of these. */
export type VfsErrorCode =
  | "not-found"
  | "invalid-path"
  | "is-a-directory"
  | "not-a-directory"
  | "not-writable"
  | "too-large"
  | "binary-file"
  | "io-error";

export type VfsResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: VfsErrorCode;
      readonly detail?: string;
    };

export function vfsOk<T>(value: T): VfsResult<T> {
  return { ok: true, value };
}

export function vfsError<T>(
  error: VfsErrorCode,
  detail?: string,
): VfsResult<T> {
  return { ok: false, error, ...(detail !== undefined ? { detail } : {}) };
}

/** One node's metadata — also the shape of directory listing entries. */
export interface VfsStat {
  /** Root-relative path (`skills/review-pr/SKILL.md`); "" is the root. */
  readonly path: string;
  /** Last path segment; the mount name for a mount root. */
  readonly name: string;
  readonly kind: VfsNodeKind;
  /** Content size in bytes, when the mount can know it cheaply. */
  readonly size?: number;
  /** Last modification, epoch ms, when known. */
  readonly modifiedAt?: number;
  /** Whether write() can target this node (or nodes under this dir). */
  readonly writable: boolean;
  /**
   * Where this node lives on disk, for file-backed mounts. Absent on
   * synthetic nodes — they have no disk representation. This is what lets
   * OS-level tools (shell, editors) reach a node the namespace named.
   */
  readonly osPath?: string;
}

/**
 * One mounted store. Implementations receive mount-relative paths that the
 * resolver has already normalized (no "..", no backslashes, no empty
 * segments) and return stats with mount-relative `path`s.
 */
export interface VfsMount {
  /** One line shown when listing the namespace root. */
  readonly description: string;
  /** Can write() ever succeed here? Synthetic views say false. */
  readonly writable: boolean;
  /**
   * Absolute disk root, for file-backed mounts. The single fact that makes
   * addresses bidirectional: the resolver routes OS-absolute addresses into
   * the mount by containment, and `Vfs.locate` maps namespace addresses
   * back to disk. Synthetic mounts omit it.
   */
  readonly osRoot?: string;
  stat(rel: string): VfsResult<VfsStat>;
  list(rel: string): VfsResult<VfsStat[]>;
  read(rel: string): VfsResult<string>;
  /** Optional — absent means the whole mount is read-only. */
  write?(rel: string, content: string): VfsResult<VfsStat>;
}

/** Read cap — a namespace read is a context payload, not a file transfer. */
export const VFS_MAX_READ_BYTES = 256 * 1024;
