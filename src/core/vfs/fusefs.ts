/**
 * FUSE layer lifecycle — mounts the talon:// namespace at ~/.talon/ns
 * while the daemon runs.
 *
 * The mount serves symlinks for file-backed mounts (kernel-followed, so
 * heavy I/O never crosses FUSE) and answers synthetic subtrees (proc/,
 * plugins/) live from the JS Vfs over the addon's callback bridge. When
 * anything is missing — config off, addon absent, no /dev/fuse, mount
 * or sanity check fails — the layer degrades to the plain symlink farm
 * and records why: fuseless hosts get the identical experience minus
 * live views, never an error at boot.
 *
 * Deadlock rule: the daemon must never do SYNCHRONOUS fs I/O under
 * ~/.talon/ns — a sync call blocks the one JS thread that answers the
 * bridge, wedging both sides. Async fs is safe (libuv worker blocks,
 * the event loop answers), and child/external processes are always
 * safe. The bridge handler itself only touches in-memory synthetic
 * mounts, keeping replies non-blocking by construction.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { log, logWarn } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import type { NativeFuseFs } from "../../native/fusefs.js";
import { nativeFuseFs } from "../../native/fusefs.js";
import { syncNamespaceDir } from "./nsdir.js";
import type { VfsErrorCode } from "./types.js";
import type { Vfs } from "./vfs.js";

export type FuseStatus = {
  readonly mounted: boolean;
  /** Why the layer is off — set exactly when `mounted` is false. */
  readonly reason?: string;
};

/** How long a post-mount sanity probe may take before we bail out. */
const SANITY_TIMEOUT_MS = 3_000;

let status: FuseStatus = { mounted: false, reason: "not started" };
let activeAddon: NativeFuseFs | null = null;

/** Is the FUSE layer live? Consulted by the address/command resolvers. */
export function isNamespaceFsMounted(): boolean {
  return status.mounted;
}

/** Current layer status, for doctor/status surfaces. */
export function namespaceFsStatus(): FuseStatus {
  return status;
}

/** Test seam — force a status without a real mount. */
export function _setNamespaceFsStatusForTesting(next: FuseStatus): void {
  status = next;
}

// ── Bridge: FUSE thread → JS Vfs ─────────────────────────────────────────────

const ERRNO: Record<VfsErrorCode, string> = {
  "not-found": "ENOENT",
  "invalid-path": "ENOENT",
  "is-a-directory": "EISDIR",
  "not-a-directory": "ENOTDIR",
  "not-writable": "EROFS",
  "too-large": "EFBIG",
  "binary-file": "EIO",
  "io-error": "EIO",
};

/**
 * Answer one bridge request. Pure Vfs → JSON: `path` is
 * namespace-relative ("proc/tasks/7"); ops are stat / list / read.
 * Never throws — every failure becomes an errno reply, because an
 * unanswered request strands a kernel caller until the addon times it
 * out.
 */
export function serveNamespaceRequest(
  vfs: Vfs,
  op: string,
  path: string,
): string {
  try {
    const address = `talon://${path}`;
    if (op === "stat") {
      const result = vfs.stat(address);
      if (!result.ok) return errno(result.error);
      return JSON.stringify({
        ok: true,
        kind: result.value.kind,
        size: result.value.size ?? 0,
        mtimeMs: result.value.modifiedAt ?? 0,
      });
    }
    if (op === "list") {
      const result = vfs.list(address);
      if (!result.ok) return errno(result.error);
      return JSON.stringify({
        ok: true,
        entries: result.value.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
        })),
      });
    }
    if (op === "read") {
      const result = vfs.read(address);
      if (!result.ok) return errno(result.error);
      return JSON.stringify({
        ok: true,
        data: Buffer.from(result.value, "utf-8").toString("base64"),
      });
    }
    return errno("io-error");
  } catch {
    return JSON.stringify({ ok: false, errno: "EIO" });
  }
}

function errno(code: VfsErrorCode): string {
  return JSON.stringify({ ok: false, errno: ERRNO[code] });
}

// ── Mount lifecycle ──────────────────────────────────────────────────────────

export interface MountOptions {
  /** `config.fuse` — "auto" mounts when possible, "off" never mounts. */
  mode: "auto" | "off";
  vfs: Vfs;
  /** Test seams; production callers omit them. */
  nsRoot?: string;
  addon?: NativeFuseFs | null;
}

/**
 * Bring the FUSE layer up if this host can. Never throws: every failure
 * path lands in `{ mounted: false, reason }` with the symlink farm
 * already synced, so the fuseless experience is intact regardless.
 */
export async function mountNamespaceFs(
  options: MountOptions,
): Promise<FuseStatus> {
  const nsRoot = options.nsRoot ?? dirs.ns;
  await recoverStaleMount(nsRoot);
  try {
    syncNamespaceDir(options.vfs, nsRoot);
  } catch (err) {
    return down(`namespace dir sync failed: ${message(err)}`);
  }

  if (options.mode === "off") return down('disabled (config fuse: "off")');
  if (process.platform !== "linux") {
    return down("FUSE layer is Linux-only for now");
  }
  if (!existsSync("/dev/fuse")) return down("/dev/fuse not present");

  const addon = options.addon !== undefined ? options.addon : nativeFuseFs();
  if (!addon) return down("talon-fusefs addon not available");

  const synthetic = options.vfs
    .describeMounts()
    .filter((mount) => mount.osRoot === undefined)
    .map((mount) => mount.name);
  const symlinks = options.vfs
    .describeMounts()
    .filter((mount) => mount.osRoot !== undefined)
    .map((mount) => ({ name: mount.name, target: mount.osRoot! }));

  try {
    addon.mount(nsRoot, symlinks, synthetic, (id, op, path) => {
      addon.reply(id, serveNamespaceRequest(options.vfs, op, path));
    });
  } catch (err) {
    return down(`mount failed: ${message(err)}`);
  }
  activeAddon = addon;

  // Sanity: the mount must actually answer before we advertise it.
  // Async fs only — see the deadlock rule in the module doc.
  const probe = synthetic[0];
  const healthy = await withTimeout(
    (async () => {
      const entries = await readdir(nsRoot);
      if (probe !== undefined && !entries.includes(probe)) return false;
      if (probe !== undefined) {
        if (!(await stat(`${nsRoot}/${probe}`)).isDirectory()) return false;
      }
      return true;
    })(),
    SANITY_TIMEOUT_MS,
  );
  if (healthy !== true) {
    await unmountNamespaceFs();
    // The failed mount may have shadowed the symlink farm — restore it.
    try {
      syncNamespaceDir(options.vfs, nsRoot);
    } catch {
      // best effort; the boot log already carries the real failure
    }
    return down(
      healthy === false
        ? "mount sanity check failed (synthetic mounts not visible)"
        : `mount sanity check timed out after ${SANITY_TIMEOUT_MS}ms`,
    );
  }

  status = { mounted: true };
  log("fusefs", `talon:// namespace mounted at ${nsRoot}`);
  return status;
}

/** Tear the layer down (daemon shutdown). Never throws, idempotent. */
export async function unmountNamespaceFs(): Promise<void> {
  const addon = activeAddon;
  activeAddon = null;
  if (status.mounted) status = { mounted: false, reason: "unmounted" };
  if (!addon) return;
  try {
    addon.unmount();
  } catch (err) {
    logWarn("fusefs", `unmount failed: ${message(err)}`);
  }
}

/**
 * A daemon that died without unmounting leaves the mountpoint wedged —
 * every syscall answers ENOTCONN ("transport endpoint is not
 * connected") until someone detaches it. A predecessor that is alive
 * but not answering is worse: its mount HANGS syscalls instead, so the
 * probe itself carries a timeout and a hang counts as stale. Detect
 * and lazy-unmount before touching the directory.
 */
async function recoverStaleMount(nsRoot: string): Promise<void> {
  const probe = await withTimeout(
    stat(nsRoot).then(
      () => "ok" as const,
      (err) => (err as NodeJS.ErrnoException).code ?? "error",
    ),
    SANITY_TIMEOUT_MS,
  );
  if (probe !== "ENOTCONN" && probe !== "timeout") return;
  logWarn("fusefs", `stale mount at ${nsRoot} — detaching`);
  for (const bin of ["fusermount3", "fusermount"]) {
    const result = spawnSync(bin, ["-uz", nsRoot], { stdio: "ignore" });
    if (result.status === 0) return;
  }
  spawnSync("umount", ["-l", nsRoot], { stdio: "ignore" });
}

function down(reason: string): FuseStatus {
  status = { mounted: false, reason };
  log("fusefs", `FUSE layer off — ${reason}`);
  return status;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([
    work,
    new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), ms);
      timer.unref();
    }),
  ]);
}
