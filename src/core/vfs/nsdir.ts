/**
 * The namespace on disk — ~/.talon/ns/, the OS spelling of talon://.
 *
 * One symlink per file-backed mount (home → workspace/, skills/, …), so
 * `talon://` ↔ `~/.talon/ns/` is a pure prefix substitution: any shell
 * command, editor, or external tool reaches namespace nodes through
 * ordinary paths. Synthetic mounts (proc/, plugins/) are NOT represented
 * here — they exist only while the FUSE layer (core/vfs/fusefs.ts) is
 * mounted over this directory, exactly like /proc appearing at boot.
 *
 * The sync is idempotent and owns only symlinks: stale or retargeted
 * links it created are replaced, anything that isn't a symlink is left
 * untouched and reported rather than deleted.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirs } from "../../util/paths.js";
import type { Vfs } from "./vfs.js";

export interface NsDirSync {
  /** Symlinks created or retargeted this pass (mount names). */
  readonly linked: string[];
  /** Stale symlinks removed (no longer a mount, or wrong target). */
  readonly pruned: string[];
  /** Entries skipped because they aren't symlinks we own. */
  readonly foreign: string[];
}

/**
 * Bring ~/.talon/ns/ (or `nsRoot`) in line with the mount table. Safe to
 * call repeatedly; called at daemon boot before the FUSE layer mounts
 * over the directory. Mount targets are created if missing so the links
 * are never dangling — workspace directories appear lazily elsewhere too.
 */
export function syncNamespaceDir(
  vfs: Vfs,
  nsRoot: string = dirs.ns,
): NsDirSync {
  mkdirSync(nsRoot, { recursive: true });
  const desired = new Map(
    vfs
      .describeMounts()
      .filter((mount) => mount.osRoot !== undefined)
      .map((mount) => [mount.name, mount.osRoot!]),
  );

  const linked: string[] = [];
  const pruned: string[] = [];
  const foreign: string[] = [];

  for (const entry of readdirSync(nsRoot)) {
    const path = `${nsRoot}/${entry}`;
    if (!lstatSync(path).isSymbolicLink()) {
      foreign.push(entry);
      // A foreign entry shadowing a mount name wins — we never delete
      // what we didn't create, so don't try to link over it either.
      desired.delete(entry);
      continue;
    }
    const target = desired.get(entry);
    if (target !== undefined && readlinkSync(path) === target) {
      desired.delete(entry); // already correct
      continue;
    }
    rmSync(path);
    if (target === undefined) pruned.push(entry);
  }

  for (const [name, target] of desired) {
    mkdirSync(target, { recursive: true });
    // "dir" matters only on Windows (junction-style resolution); ignored
    // elsewhere.
    symlinkSync(target, `${nsRoot}/${name}`, "dir");
    linked.push(name);
  }

  return { linked, pruned, foreign };
}
