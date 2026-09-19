/**
 * The snapshot builder — one run, one directory, two parts.
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
import { TarWriter } from "./archive/tar.js";
import { createCompressor } from "./archive/zstd.js";
import {
  collectTree,
  expandUserPath,
  isExcluded,
  isInside,
  EXCLUDE_RULES,
  HOME_INCLUDES,
  workspaceRoots,
  type SourceEntry,
} from "./plan.js";
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

/**
 * Write one compressed part and return its size and digest. The digest is
 * taken off the compressed bytes, so verifying a part before extraction
 * costs one pass over the file and no decompression.
 */
async function writePart(
  destPath: string,
  fill: (writer: TarWriter) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  await mkdir(dirname(destPath), { recursive: true });
  const compressor = createCompressor();
  const tap = new Sha256Tap();
  const out = createWriteStream(destPath);
  const flushed = pipeline(compressor, tap, out);
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

/** Everything under ~/.talon plus the configured workspace subset and extras. */
async function collectStateEntries(
  home: string,
  settings: BackupSettings,
): Promise<{
  entries: SourceEntry[];
  includes: string[];
  extras: { n: number; source: string }[];
}> {
  const skipped: string[] = [];
  const onSkip = (path: string, err: unknown) => {
    skipped.push(
      `${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
  const entries: SourceEntry[] = [];
  const includes: string[] = [];

  for (const root of HOME_INCLUDES) {
    const found = await collectTree(join(home, root), root, { onSkip });
    if (found.length > 0) {
      entries.push(...found);
      includes.push(root);
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
  return { entries, includes, extras };
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
): Promise<{ part: SnapshotPart; palaceHash: string } | null> {
  const palaceDir = join(home, "workspace", "palace");
  const entries = await collectTree(palaceDir, "workspace/palace", {
    exclude: palaceExclude,
  });
  if (entries.length === 0) return null;

  const palaceHash = await palaceFingerprint(entries);
  const name = `palace-${palaceHash.slice(0, 12)}.tar.zst`;
  const dest = join(snapshotDir(id, home), name);

  for (const previous of await listLocalManifests(home)) {
    if (previous.palaceHash !== palaceHash) continue;
    const reusable = previous.parts.find((part) => part.name === name);
    if (!reusable) continue;
    try {
      await linkOrCopy(join(snapshotDir(previous.id, home), name), dest);
      log("backup", `Reused palace part from ${previous.id} (${name})`);
      return { part: { ...reusable, contentAddressed: true }, palaceHash };
    } catch (err) {
      logWarn(
        "backup",
        `Could not reuse palace part from ${previous.id}: ${String(err)}`,
      );
      break;
    }
  }

  const written = await writePart(dest, (writer) =>
    addEntries(writer, entries),
  );
  return {
    part: {
      name,
      bytes: written.bytes,
      sha256: written.sha256,
      contentAddressed: true,
    },
    palaceHash,
  };
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

/**
 * Build one snapshot end to end: collect, archive, hash, write the
 * manifest, index it. Leaves nothing behind on failure — a half-written
 * directory would be indistinguishable from a good snapshot at restore
 * time, which is the one thing a safety net may not be.
 */
export async function buildSnapshot(options: BuildOptions): Promise<Manifest> {
  const home = options.home ?? dirs.root;
  const id = newSnapshotId(options.now ?? new Date());
  const dir = snapshotDir(id, home);
  const started = Date.now();
  await mkdir(dir, { recursive: true });

  try {
    const { entries, includes, extras } = await collectStateEntries(
      home,
      options.settings,
    );
    const dbTemp = join(dir, "db-snapshot.tmp");
    await rm(dbTemp, { force: true });
    (options.copyDatabase ?? snapshotDatabase)(dbTemp);
    const dbStat = await stat(dbTemp);

    const state = await writePart(join(dir, STATE_PART), async (writer) => {
      await addEntries(writer, entries);
      await writer.addFile(
        DB_MEMBER,
        dbTemp,
        0o600,
        Math.floor(Date.now() / 1000),
        dbStat.size,
      );
    });
    await rm(dbTemp, { force: true });

    const parts: SnapshotPart[] = [
      { name: STATE_PART, bytes: state.bytes, sha256: state.sha256 },
    ];
    let palaceHash: string | undefined;
    if (options.settings.includePalace) {
      const palace = await buildPalacePart(id, home);
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
      ...(extras.length > 0 ? { extras } : {}),
      ...(palaceHash ? { palaceHash } : {}),
      sizeBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
      remote: {},
    };
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
