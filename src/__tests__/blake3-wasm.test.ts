/**
 * Real-behavior tests for the Rust→WASM BLAKE3 module
 * (native/blake3-wasm + src/native/blake3.ts).
 *
 * Digest correctness is pinned to the official upstream test vectors
 * (BLAKE3-team/BLAKE3 test_vectors/test_vectors.json): input byte i is
 * `i % 251`, expected hash is the first 32 bytes of the extended output.
 * Note the empty-input digest is af1349b9...e41f3262 — a widely
 * mis-quoted variant ends ...baf4ba1a8 and shares the first 23 hex chars,
 * so these expectations were re-verified against the upstream JSON, not
 * from memory.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Wasm-pinned exports: this suite proves the embedded wasm module,
// regardless of whether the optional napi addon is built locally.
import {
  blake3HexWasm as blake3Hex,
  blake3HexFileWasm as blake3HexFile,
} from "../native/blake3.js";

/** Official test-vector input: repeating byte pattern 0,1,...,250,0,1,... */
function officialInput(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i++) buf[i] = i % 251;
  return buf;
}

const OFFICIAL_VECTORS = [
  {
    inputLen: 0,
    hash: "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
  },
  {
    inputLen: 3,
    hash: "e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f",
  },
  {
    inputLen: 1024,
    hash: "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7",
  },
  // 100KiB: spans many 1KiB chunks — exercises the chunk-tree path, not
  // just single-block compression.
  {
    inputLen: 102400,
    hash: "bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085",
  },
] as const;

describe("blake3 wasm module", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "blake3-wasm-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches the official BLAKE3 test vectors", async () => {
    for (const { inputLen, hash } of OFFICIAL_VECTORS) {
      await expect(blake3Hex(officialInput(inputLen))).resolves.toBe(hash);
    }
  });

  it("hashes the empty string to the empty-input vector", async () => {
    await expect(blake3Hex("")).resolves.toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("is deterministic on >64KB random input and sensitive to one bit", async () => {
    const big = randomBytes(96 * 1024); // > one 64KB subtree boundary
    const first = await blake3Hex(big);
    const second = await blake3Hex(big);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const variant = Buffer.from(big);
    variant[70_000] ^= 0x01; // flip one bit deep in the buffer
    await expect(blake3Hex(variant)).resolves.not.toBe(first);
  });

  it("treats string input as the UTF-8 encoding of the same bytes", async () => {
    const text = "talon media dedupe — δοκιμή 🦀";
    const asString = await blake3Hex(text);
    const asBytes = await blake3Hex(new TextEncoder().encode(text));
    expect(asString).toBe(asBytes);
  });

  it("stays stable and leak-free across 200 repeated calls", async () => {
    const payload = randomBytes(1024 * 1024); // 1MiB per call
    const expected = await blake3Hex(payload);
    const rssBefore = process.memoryUsage().rss;

    for (let i = 0; i < 200; i++) {
      expect(await blake3Hex(payload)).toBe(expected);
    }

    // A dealloc regression would strand ~200MiB of wasm linear memory
    // (1MiB input per call, never reused). Linear memory lives in RSS, so
    // a generous 128MiB ceiling catches that while ignoring GC noise.
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    expect(rssGrowth).toBeLessThan(128 * 1024 * 1024);
  });

  it("handles interleaved concurrent calls correctly", async () => {
    const inputs = Array.from({ length: 32 }, (_, i) => officialInput(i * 37));
    const sequential: string[] = [];
    for (const input of inputs) sequential.push(await blake3Hex(input));
    const concurrent = await Promise.all(
      inputs.map((input) => blake3Hex(input)),
    );
    expect(concurrent).toEqual(sequential);
  });

  it("hashes a file identically to hashing its bytes", async () => {
    const bytes = randomBytes(200 * 1024);
    const path = join(dir, "roundtrip.bin");
    await writeFile(path, bytes);
    await expect(blake3HexFile(path)).resolves.toBe(await blake3Hex(bytes));
  });

  it("hashes an empty file to the empty-input vector", async () => {
    const path = join(dir, "empty.bin");
    await writeFile(path, Buffer.alloc(0));
    await expect(blake3HexFile(path)).resolves.toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("streams multi-chunk files identically to one-shot hashing", async () => {
    // 5MiB+13: several 1MiB streaming chunks plus a ragged tail, so the
    // incremental hasher_update path crosses chunk boundaries unevenly.
    const bytes = randomBytes(5 * 1024 * 1024 + 13);
    const path = join(dir, "large.bin");
    await writeFile(path, bytes);
    await expect(blake3HexFile(path)).resolves.toBe(await blake3Hex(bytes));
  });

  it("matches the official vectors through the streaming file path", async () => {
    // Pin the incremental ABI to upstream truth, not just to blake3Hex.
    const { inputLen, hash } = OFFICIAL_VECTORS[3]; // 100KiB chunk-tree case
    const path = join(dir, "vector.bin");
    await writeFile(path, officialInput(inputLen));
    await expect(blake3HexFile(path)).resolves.toBe(hash);
  });

  it("interleaves concurrent file hashes without cross-talk", async () => {
    // Distinct contents hashed concurrently: per-handle hasher state must
    // not bleed across awaits between file-read chunks.
    const files = await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const bytes = randomBytes(512 * 1024 + i);
        const path = join(dir, `interleave-${i}.bin`);
        await writeFile(path, bytes);
        return { path, expected: await blake3Hex(bytes) };
      }),
    );
    const hashes = await Promise.all(files.map((f) => blake3HexFile(f.path)));
    expect(hashes).toEqual(files.map((f) => f.expected));
  });

  it("rejects on missing files without leaking the hasher handle", async () => {
    // The createReadStream rejection takes the hasher_free cleanup path;
    // 50 failures then a correct success would catch a leak-induced fault.
    for (let i = 0; i < 50; i++) {
      await expect(
        blake3HexFile(join(dir, "does-not-exist.bin")),
      ).rejects.toThrow();
    }
    await expect(blake3Hex("")).resolves.toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });
});
