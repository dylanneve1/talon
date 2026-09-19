/**
 * Digests — what makes a snapshot verifiable and the palace part reusable.
 *
 * Two jobs:
 *   - `Sha256Tap` sits in the write pipeline and hashes the COMPRESSED
 *     bytes on their way to disk, so the manifest's sha256 is produced
 *     without a second pass over a multi-GB part. The restore path checks
 *     the same digest before it unpacks anything.
 *   - `treeHash` fingerprints a directory (path + size + mtime + content
 *     digest of every file) so an unchanged memory palace can be carried
 *     forward from the previous snapshot instead of recompressed and
 *     re-uploaded every six hours.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";

/** Pass-through stream that hashes (and counts) everything crossing it. */
export class Sha256Tap extends Transform {
  private readonly hash = createHash("sha256");
  private digested: string | null = null;
  private seen = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: TransformCallback,
  ): void {
    this.hash.update(chunk);
    this.seen += chunk.length;
    done(null, chunk);
  }

  /** Hex digest of everything written. Valid once the stream has finished. */
  digest(): string {
    if (this.digested === null) this.digested = this.hash.digest("hex");
    return this.digested;
  }

  /** Bytes seen so far — the part's size, without a stat() race. */
  get byteLength(): number {
    return this.seen;
  }
}

/** Streaming sha256 of a file on disk. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** One file's identity inside a tree fingerprint. */
export type TreeFile = {
  /** Path relative to the tree root, POSIX separators. */
  path: string;
  size: number;
  /** Modification time in epoch SECONDS (tar's resolution — stable). */
  mtime: number;
  sha256: string;
};

/**
 * Fingerprint a set of files. Sorted by path so the value depends on the
 * content of the tree and not on readdir order.
 */
export function treeHash(files: readonly TreeFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    hash.update(`${file.path}\0${file.size}\0${file.mtime}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}
