/**
 * Zstandard streams — the compression half of a snapshot part.
 *
 * `node:zlib` has shipped zstd since Node 23 and bun 1.2, so a snapshot
 * needs no dependency and no native addon: verified present on the two
 * runtimes Talon supports (Node 24.19, bun 1.3.9). Level 19 is the
 * archival end of the dial — snapshots are written once every few hours
 * and read almost never, so CPU at write time is the cheap resource and
 * bytes on someone else's disk is the expensive one.
 *
 * Both factories return duplex streams, so the caller pipes rather than
 * buffers: a multi-GB workspace never lands in memory.
 */

import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import type { Transform } from "node:stream";

/** Archival compression level (1–22). */
const ZSTD_LEVEL = 19;

/** A zstd compressor for one part. */
export function createCompressor(level: number = ZSTD_LEVEL): Transform {
  return createZstdCompress({
    params: { [constants.ZSTD_c_compressionLevel]: level },
  });
}

/** A zstd decompressor for one part. */
export function createDecompressor(): Transform {
  return createZstdDecompress();
}
