/**
 * The snapshot builder — one run, one directory, up to three parts
 * (state, login sessions, palace).
 *
 * Everything here streams: entries are handed to the tar writer one at a
 * time, the tar bytes go straight through zstd into the part file, and
 * the sha256 is taken off the compressed stream on its way past. A
 * multi-gigabyte workspace therefore costs one chunk of memory, not one
 * workspace.
 *
 * Two rules worth keeping in mind while reading:
 *
 *   - The database is never copied from disk. `VACUUM INTO` (see
 *     storage/db.ts) hands us a consistent single-file copy that goes in
 *     as `db/talon.db`; the live `data/talon.db*` files are excluded.
 *   - The memory palace is content-addressed. Its tree fingerprint is
 *     computed first, and if it matches the previous snapshot's the old
 *     part is hard-linked instead of recompressed — which is what makes
 *     a six-hourly backup of a large palace nearly free, locally and on
 *     every remote target.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { dirs } from "../../util/paths.js";
import { log, logWarn } from "../../util/log.js";
import { talonVersion } from "../../util/version.js";
import { snapshotDatabase } from "../../storage/backup/index.js";
import { TalonError } from "../errors.js";
import {
  Sha256Tap,
  sha256File,
  treeHash,
  type TreeFile,
} from "./archive/digest.js";
import {
  ENCRYPTED_SUFFIX,
  createEncryptor,
  passphraseOpens,
} from "./archive/crypt.js";
import { signManifest } from "./archive/manifest-auth.js";
import { TarWriter } from "./archive/tar.js";
import { createCompressor } from "./archive/zstd.js";
import {
  collectTree,
  expandUserPath,
  isExcluded,
  isInside,
  EXCLUDE_RULES,
  HOME_INCLUDES,
  LOGIN_INCLUDES,
  workspaceRoots,
  type SourceEntry,
} from "./plan.js";
import { passphraseFilePath, resolvePassphrase } from "./passphrase.js";
import {
  STATE_PART,
  indexSnapshot,
  linkOrCopy,
  listLocalManifests,
  newSnapshotId,
  snapshotDir,
  writeManifest,
} from "./store.js";
import type {
  BackupSettings,
  Manifest,
  SnapshotKind,
  SnapshotPart,
} from "./types.js";

/** Where the database copy lands inside the archive. */
const DB_MEMBER = "db/talon.db";
/** The part that holds WhatsApp auth and the userbot session. */
const LOGINS_PART = "logins.tar.zst";

export type BuildOptions = {
  kind: SnapshotKind;
  label?: string;
  pinned?: boolean;
  settings: BackupSettings;
  /** Talon home; tests point this at a scratch directory. */
  home?: string;
  /** Database copier — injected by tests that have no database. */
  copyDatabase?: (destPath: string) => void;
  /** Clock, for deterministic ids in tests. */
  now?: Date;
};

// ── Archive writing ─────────────────────────────────────────────────────────

async function addEntries(
  writer: TarWriter,
  entries: readonly SourceEntry[],
): Promise<void> {
  for (const entry of entries) {
    if (entry.type === "dir") {
      await writer.addDirectory(entry.archivePath, entry.mode, entry.mtime);
    } else if (entry.type === "symlink") {
      await writer.addSymlink(
        entry.archivePath,
        entry.linkTarget ?? "",
        entry.mode,
        entry.mtime,
      );
    } else {
      await writer.addFile(
        entry.archivePath,
        entry.source,
        entry.mode,
        entry.mtime,
        entry.size,
      );
    }
  }
}

/** A part's file name: `.enc` marks one written through the encryptor. */
function partName(base: string, passphrase: string | null): string {
  return passphrase ? `${base}${ENCRYPTED_SUFFIX}` : base;
}

/**
 * Write one compressed (and, with a passphrase, encrypted) part and
 * return its size and digest. The digest is taken off the bytes as they
 * land on disk, so verifying a part before extraction costs one pass
 * over the file and no decompression.
 */
async function writePart(
  destPath: string,
  fill: (writer: TarWriter) => Promise<void>,
  passphrase: string | null,
): Promise<{ bytes: number; sha256: string }> {
  await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
  const compressor = createCompressor();
  const tap = new Sha256Tap();
  // Owner-only even when encrypted: a plaintext local part holds every
  // credential this install has.
  const out = createWriteStream(destPath, { mode: 0o600 });
  const flushed = passphrase
    ? pipeline(compressor, await createEncryptor(passphrase), tap, out)
    : pipeline(compressor, tap, out);
  try {
    const writer = new TarWriter(compressor);
    await fill(writer);
    await writer.finalize();
    compressor.end();
    await flushed;
  } catch (err) {
    compressor.destroy();
    out.destroy();
    await rm(destPath, { force: true });
    throw err;
  }
  return { bytes: tap.byteLength, sha256: tap.digest() };
}

// ── What goes in ────────────────────────────────────────────────────────────

type Collected = {
  entries: SourceEntry[];
  /** WhatsApp auth + userbot session, bound for their own part. */
  logins: SourceEntry[];
  includes: string[];
  extras: { n: number; source: string }[];
};

/**
 * Drop the passphrase file wherever it turned up (an extra path, the
 * secrets folder): a key inside the backup it unlocks is no key at all.
 */
function withoutKeyFile(
  entries: SourceEntry[],
  keyFile: string | null,
): SourceEntry[] {
  if (!keyFile) return entries;
  const kept = entries.filter((entry) => resolve(entry.source) !== keyFile);
  if (kept.length !== entries.length) {
    logWarn(
      "backup",
      `Left the backup passphrase file ${keyFile} out of the snapshot — keep it outside backed-up paths`,
    );
  }
  return kept;
}

/** Everything under ~/.talon plus the configured workspace subset and extras. */
async function collectStateEntries(
  home: string,
  settings: BackupSettings,
): Promise<Collected> {
  const skipped: string[] = [];
  const onSkip = (path: string, err: unknown) => {
    skipped.push(
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  const entries: SourceEntry[] = [];
  const logins: SourceEntry[] = [];
  const includes: string[] = [];

  for (const root of HOME_INCLUDES) {
    const found = await collectTree(join(home, root), root, { onSkip });
    if (found.length > 0) {
      entries.push(...found);
      includes.push(root);
    }
  }
  if (settings.loginSessions !== "off") {
    for (const root of LOGIN_INCLUDES) {
      const found = await collectTree(join(home, root), root, { onSkip });
      if (found.length > 0) {
        logins.push(...found);
        includes.push(root);
      }
    }
  }
  for (const root of workspaceRoots(settings.workspaceInclude)) {
    const archiveRoot = `workspace/${root}`;
    const found = await collectTree(
      join(home, "workspace", root),
      archiveRoot,
      { onSkip },
    );
    if (found.length > 0) {
      entries.push(...found);
      includes.push(archiveRoot);
    }
  }
  const extras: { n: number; source: string }[] = [];
  for (const [index, raw] of settings.extraPaths.entries()) {
    const source = expandUserPath(raw);
    // Never reach into the FUSE namespace (it can be a dead mount) or back
    // into the backup directory itself.
    if (
      isInside(join(home, "ns"), source) ||
      isInside(join(home, "backups"), source)
    ) {
      logWarn(
        "backup",
        `extraPaths entry skipped (inside ~/.talon/ns or backups/): ${raw}`,
      );
      continue;
    }
    const archiveRoot = `extra/${index}`;
    const found = await collectTree(source, archiveRoot, { onSkip });
    if (found.length === 0) {
      logWarn("backup", `extraPaths entry is empty or unreadable: ${raw}`);
      continue;
    }
    entries.push(...found);
    includes.push(archiveRoot);
    extras.push({ n: index, source });
  }
  if (skipped.length > 0) {
    logWarn(
      "backup",
      `Skipped ${skipped.length} unreadable path(s); first: ${skipped[0]}`,
    );
  }
  const keyFile = passphraseFilePath(settings);
  return {
    entries: withoutKeyFile(entries, keyFile),
    logins: withoutKeyFile(logins, keyFile),
    includes,
    extras,
  };
}

// ── The memory palace part ──────────────────────────────────────────────────

/** Palace members, exempt from the rule that keeps them out of the state part. */
function palaceExclude(archivePath: string): boolean {
  if (
    archivePath === "workspace/palace" ||
    archivePath.startsWith("workspace/palace/")
  ) {
    return false;
  }
  return isExcluded(archivePath);
}

/**
 * Fingerprint the palace: path + size + mtime + content digest of every
 * file. Content, not just mtime, because a restored or re-synced palace
 * has new timestamps and identical bytes — and re-uploading gigabytes
 * over a changed mtime is exactly what this is here to avoid.
 */
async function palaceFingerprint(
  entries: readonly SourceEntry[],
): Promise<string> {
  const files: TreeFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    files.push({
      path: entry.archivePath,
      size: entry.size,
      mtime: entry.mtime,
      sha256: await sha256File(entry.source),
    });
  }
  return treeHash(files);
}

/**
 * Build (or reuse) the palace part. Reuse means an identical part already
 * exists in an older snapshot: same name, same bytes, so it is hard-linked
 * and marked `contentAddressed` — targets that already hold it skip the
 * upload too.
 */
async function buildPalacePart(
  id: string,
  home: string,
  passphrase: string | null,
): Promise<{ part: SnapshotPart; palaceHash: string } | null> {
  const palaceDir = join(home, "workspace", "palace");
  const entries = await collectTree(palaceDir, "workspace/palace", {
    exclude: palaceExclude,
  });
  if (entries.length === 0) return null;

  const palaceHash = await palaceFingerprint(entries);
  const name = partName(
    `palace-${palaceHash.slice(0, 12)}.tar.zst`,
    passphrase,
  );
  const dest = join(snapshotDir(id, home), name);

  const reused = await reusePalacePart(
    home,
    palaceHash,
    name,
    dest,
    passphrase,
  );
  if (reused) return { part: reused, palaceHash };

  const written = await writePart(
    dest,
    (writer) => addEntries(writer, entries),
    passphrase,
  );
  return {
    part: {
      name,
      bytes: written.bytes,
      sha256: written.sha256,
      contentAddressed: true,
      ...(passphrase ? { encrypted: true } : {}),
    },
    palaceHash,
  };
}

/**
 * Hard-link an identical palace part from an older snapshot, if there is
 * one. An encrypted part is only reused when the current passphrase opens
 * it — after a key change the palace is re-encrypted rather than carried
 * forward under a key the operator may no longer hold.
 */
async function reusePalacePart(
  home: string,
  palaceHash: string,
  name: string,
  dest: string,
  passphrase: string | null,
): Promise<SnapshotPart | null> {
  for (const previous of await listLocalManifests(home)) {
    if (previous.palaceHash !== palaceHash) continue;
    const reusable = previous.parts.find((part) => part.name === name);
    if (!reusable) continue;
    const source = join(snapshotDir(previous.id, home), name);
    if (passphrase && !(await passphraseOpens(source, passphrase))) break;
    try {
      await linkOrCopy(source, dest);
      log("backup", `Reused palace part from ${previous.id} (${name})`);
      return { ...reusable, contentAddressed: true };
    } catch (err) {
      logWarn(
        "backup",
        `Could not reuse palace part from ${previous.id}: ${String(err)}`,
      );
      break;
    }
  }
  return null;
}

// ── Provenance ──────────────────────────────────────────────────────────────

/** Short git HEAD of the checkout Talon runs from, when there is one. */
async function readGitHead(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    try {
      const head = (await readFile(join(dir, ".git", "HEAD"), "utf8")).trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5).trim();
        const sha = await readFile(join(dir, ".git", ref), "utf8");
        return sha.trim().slice(0, 12);
      }
      return head.slice(0, 12);
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

// ── The build ───────────────────────────────────────────────────────────────

/** The state part: identity, state, workspace subset, extras and the database. */
async function writeStatePart(
  dir: string,
  entries: readonly SourceEntry[],
  passphrase: string | null,
  options: BuildOptions,
): Promise<SnapshotPart> {
  const dbTemp = join(dir, "db-snapshot.tmp");
  await rm(dbTemp, { force: true });
  (options.copyDatabase ?? snapshotDatabase)(dbTemp);
  const dbStat = await stat(dbTemp);
  const name = partName(STATE_PART, passphrase);
  const written = await writePart(
    join(dir, name),
    async (writer) => {
      await addEntries(writer, entries);
      await writer.addFile(
        DB_MEMBER,
        dbTemp,
        0o600,
        Math.floor(Date.now() / 1000),
        dbStat.size,
      );
    },
    passphrase,
  );
  await rm(dbTemp, { force: true });
  return { name, ...written, ...(passphrase ? { encrypted: true } : {}) };
}

/**
 * The login-sessions part, when there is anything to put in it. Marked
 * local-only unless the operator opted in to shipping sessions off-host.
 */
async function writeLoginsPart(
  dir: string,
  entries: readonly SourceEntry[],
  passphrase: string | null,
  settings: BackupSettings,
): Promise<SnapshotPart | null> {
  if (entries.length === 0) return null;
  const name = partName(LOGINS_PART, passphrase);
  const written = await writePart(
    join(dir, name),
    (writer) => addEntries(writer, entries),
    passphrase,
  );
  return {
    name,
    ...written,
    ...(passphrase ? { encrypted: true } : {}),
    ...(settings.loginSessions === "remote" ? {} : { localOnly: true }),
  };
}

/**
 * Build one snapshot end to end: collect, archive, hash, write the
 * manifest, index it. Leaves nothing behind on failure — a half-written
 * directory would be indistinguishable from a good snapshot at restore
 * time, which is the one thing a safety net may not be.
 */
export async function buildSnapshot(options: BuildOptions): Promise<Manifest> {
  const home = options.home ?? dirs.root;
  // Resolved before anything is written: a configured-but-broken key must
  // fail the snapshot, never degrade it to plaintext.
  const passphrase = await resolvePassphrase(options.settings);
  const id = newSnapshotId(options.now ?? new Date());
  const dir = snapshotDir(id, home);
  const started = Date.now();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  try {
    const collected = await collectStateEntries(home, options.settings);
    const { includes } = collected;
    const parts = [
      await writeStatePart(dir, collected.entries, passphrase, options),
    ];
    const logins = await writeLoginsPart(
      dir,
      collected.logins,
      passphrase,
      options.settings,
    );
    if (logins) parts.push(logins);
    let palaceHash: string | undefined;
    if (options.settings.includePalace) {
      const palace = await buildPalacePart(id, home, passphrase);
      if (palace) {
        parts.push(palace.part);
        palaceHash = palace.palaceHash;
        includes.push("workspace/palace");
      }
    }

    const gitHead = await readGitHead(process.cwd());
    const manifest: Manifest = {
      schema: 1,
      id,
      kind: options.kind,
      ...(options.label ? { label: options.label } : {}),
      pinned: options.pinned ?? false,
      createdAt: Date.now(),
      host: hostname(),
      talonVersion: talonVersion(),
      ...(gitHead ? { gitHead } : {}),
      parts,
      includes: [...includes, DB_MEMBER],
      excludes: [...EXCLUDE_RULES],
      ...(collected.extras.length > 0 ? { extras: collected.extras } : {}),
      ...(palaceHash ? { palaceHash } : {}),
      sizeBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      remote: {},
    };
    if (passphrase) manifest.auth = await signManifest(manifest, passphrase);
    await writeManifest(manifest, home);
    indexSnapshot(manifest);
    log(
      "backup",
      `Snapshot ${id} (${options.kind}${options.label ? `: ${options.label}` : ""}) ` +
        `— ${parts.length} part(s), ${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `${Math.round((Date.now() - started) / 1000)}s`,
    );
    return manifest;
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err instanceof TalonError
      ? err
      : new TalonError(
          `Snapshot ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
          { reason: "unknown", cause: err },
        );
  }
}
