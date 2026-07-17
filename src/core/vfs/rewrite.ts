/**
 * talon:// → real path translation — the seam that makes the namespace
 * seamless for OS-level tools.
 *
 * Because the namespace exists on disk (~/.talon/ns/, see nsdir.ts and
 * fusefs.ts), translating an address is pure prefix substitution — no
 * tokenizing, no quoting rules, correct anywhere in a command string:
 *
 *   FUSE mounted   talon://           →  ~/.talon/ns/           (total)
 *   fuseless       talon://home/x     →  <workspace>/x          (per mount)
 *                  talon://           →  ~/.talon/ns            (symlink farm)
 *                  talon://proc/x     →  refused — live views exist only
 *                                        while the FUSE layer is mounted
 *
 * Two consumers: `resolveNamespacePath` for a single address parameter
 * (read/write/edit/glob/search), `rewriteNamespaceRefs` for a whole
 * shell command (bash). Both return real host paths that ordinary fs
 * code and child processes use with no further special-casing.
 */

import { dirs } from "../../util/paths.js";
import type { Vfs } from "./vfs.js";

const SCHEME = "talon://";

/** Chars that can continue a mount name — used as a replace boundary. */
const MOUNT_NAME = /^[a-z0-9-]+/;

export type PathResolution =
  { ok: true; path: string } | { ok: false; error: string };

export type CommandRewrite =
  | { ok: true; command: string; mappings: string[] }
  | { ok: false; error: string };

function lockedError(name: string): string {
  return (
    `talon://${name} is a live view that only exists while the FUSE layer is ` +
    `mounted, and it isn't mounted on this host (config \`fuse: "off"\`, ` +
    `missing talon-fusefs addon, or no FUSE support). File-backed mounts ` +
    `under ${dirs.ns} keep working.`
  );
}

function unknownMountError(name: string, vfs: Vfs): string {
  const mounts = vfs
    .describeMounts()
    .map((mount) => mount.name)
    .join(", ");
  return `No mount "${name}" in the talon:// namespace — mounts: ${mounts}`;
}

function isSynthetic(name: string, vfs: Vfs): boolean {
  return vfs
    .describeMounts()
    .some((mount) => mount.name === name && mount.osRoot === undefined);
}

/**
 * Resolve one talon:// address to the real host path it names. The
 * caller has already checked the scheme prefix. With FUSE mounted every
 * address maps into the mountpoint; fuseless, file-backed mounts map to
 * their disk roots and live views are refused (they don't exist).
 */
export function resolveNamespacePath(
  address: string,
  vfs: Vfs,
  fuseMounted: boolean,
  nsRoot: string = dirs.ns,
): PathResolution {
  const rest = address.slice(SCHEME.length).replace(/^\/+/, "");
  if (rest === "") return { ok: true, path: nsRoot };
  if (fuseMounted) return { ok: true, path: `${nsRoot}/${rest}` };

  const name = MOUNT_NAME.exec(rest)?.[0] ?? "";
  if (isSynthetic(name, vfs)) return { ok: false, error: lockedError(name) };

  const located = vfs.locate(address);
  if (!located.ok) {
    return {
      ok: false,
      error: `Cannot resolve ${address}: ${located.error}${located.detail ? ` — ${located.detail}` : ""}`,
    };
  }
  if (located.value === undefined) {
    // A mount the table knows but has no disk root and isn't flagged
    // synthetic can't exist; treat as locked for the same honest reason.
    return { ok: false, error: lockedError(name) };
  }
  return { ok: true, path: located.value };
}

/**
 * Translate every talon:// reference in a shell command to its real
 * path, so `ls talon://home | head` runs untouched by any namespace
 * plumbing. Returns the applied mappings for the tool result, so the
 * translation is visible rather than silent.
 */
export function rewriteNamespaceRefs(
  command: string,
  vfs: Vfs,
  fuseMounted: boolean,
  nsRoot: string = dirs.ns,
): CommandRewrite {
  if (!command.includes("talon:")) {
    return { ok: true, command, mappings: [] };
  }
  // Near-miss schemes that are unambiguously typos get corrected rather
  // than letting the shell chase a path that never existed: the
  // single-slash form (talon:/x), and talon:<name> when <name> is a real
  // mount. Anything else containing "talon:" (a grep pattern, a log tag)
  // passes through untouched.
  const nearMiss =
    /talon:\/(?!\/)([a-z0-9-][^\s'"`]*)/.exec(command) ??
    /talon:(?!\/)([a-z0-9-]+)/.exec(command);
  if (nearMiss) {
    const rest = nearMiss[1]!;
    const name = MOUNT_NAME.exec(rest)?.[0] ?? "";
    const known = vfs.describeMounts().some((mount) => mount.name === name);
    if (nearMiss[0].startsWith("talon:/") || known) {
      return {
        ok: false,
        error: `"${nearMiss[0]}" is not an address — spell it ${SCHEME}${rest}`,
      };
    }
  }
  if (!command.includes(SCHEME)) {
    return { ok: true, command, mappings: [] };
  }

  if (fuseMounted) {
    return {
      ok: true,
      command: command.split(SCHEME).join(`${nsRoot}/`),
      mappings: [`talon:// → ${nsRoot}/`],
    };
  }

  let rewritten = command;
  const mappings: string[] = [];
  const mounts = vfs
    .describeMounts()
    .filter((mount) => mount.osRoot !== undefined)
    .sort((a, b) => b.name.length - a.name.length);
  for (const mount of mounts) {
    const ref = new RegExp(`talon://${mount.name}(?![a-z0-9-])`, "g");
    if (ref.test(rewritten)) {
      rewritten = rewritten.replace(ref, mount.osRoot!);
      mappings.push(`talon://${mount.name} → ${mount.osRoot}`);
    }
  }

  const residual = /talon:\/\/([a-z0-9-]+)/.exec(rewritten);
  if (residual) {
    const name = residual[1]!;
    return {
      ok: false,
      error: isSynthetic(name, vfs)
        ? lockedError(name)
        : unknownMountError(name, vfs),
    };
  }

  // Bare talon:// (the namespace root) — the symlink farm is always there.
  if (rewritten.includes(SCHEME)) {
    rewritten = rewritten.split(SCHEME).join(`${nsRoot}/`);
    mappings.push(`talon:// → ${nsRoot}/`);
  }
  return { ok: true, command: rewritten, mappings };
}
