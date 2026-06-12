/**
 * blake3-napi — the in-process napi-rs hashing addon
 * (native/blake3-napi) that fronts BLAKE3 media hashing when its
 * per-arch .node artifact is built, with the embedded wasm module as
 * the always-available fallback.
 *
 * These tests build the addon with the pinned Rust toolchain and drive
 * the real .node through the TS boundary, asserting what matters for a
 * silent fast-path: digest agreement with the wasm implementation on
 * every input shape (the two paths must be indistinguishable to
 * callers), promise semantics for file hashing, and that every
 * degraded mode — disabled, missing, or bogus artifact — falls back to
 * wasm instead of failing.
 *
 * If cargo is not installed the suite skips — the CI Napi job builds
 * with the pinned toolchain, mirroring the warden and driver suites.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const crateDir = fileURLToPath(
  new URL("../../native/blake3-napi", import.meta.url),
);

function findCargo(): string | null {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return "cargo";
  } catch {
    return null;
  }
}

const cargo = process.platform === "win32" ? null : findCargo();
const suite = cargo ? describe : describe.skip;
if (!cargo) {
  console.warn("blake3-napi tests skipped: cargo toolchain not found");
}

const boundary = await import("../native/blake3.js");

suite("blake3-napi addon", () => {
  let root: string;
  let addonPath: string;

  beforeAll(() => {
    // Build through the manifest, not raw cargo: build.mjs pins the
    // RUSTFLAGS path-remap, so this shares the fingerprint (and the
    // target cache) with `npm run build:napi` instead of rebuilding
    // the whole dependency graph under a second flag set.
    execFileSync(process.execPath, [join(crateDir, "build.mjs")], {
      stdio: "inherit",
    });
    root = mkdtempSync(join(tmpdir(), "blake3-napi-test-"));
    addonPath = join(root, "talon-blake3.node");
    copyFileSync(
      fileURLToPath(new URL("../../bin/talon-blake3.node", import.meta.url)),
      addonPath,
    );
  }, 180_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.TALON_BLAKE3_NODE;
    delete process.env.TALON_NO_BLAKE3_NATIVE;
    boundary._resetNativeBlake3ForTesting();
  });

  function useAddon(): void {
    process.env.TALON_BLAKE3_NODE = addonPath;
    delete process.env.TALON_NO_BLAKE3_NATIVE;
    boundary._resetNativeBlake3ForTesting();
  }

  function useWasm(): void {
    process.env.TALON_NO_BLAKE3_NATIVE = "1";
    boundary._resetNativeBlake3ForTesting();
  }

  it("loads, self-verifies, and reports a version", () => {
    useAddon();
    const addon = boundary.nativeBlake3();
    expect(addon).not.toBeNull();
    expect(addon!.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("agrees with the wasm implementation across input shapes", async () => {
    // Cover both sides of the addon's 128 KiB rayon crossover and the
    // empty/string/binary shapes media hashing actually sees.
    const inputs: (Uint8Array | string)[] = [
      "",
      "hello world",
      "naïve 🦀 — multi-byte",
      randomBytes(1024),
      randomBytes(128 * 1024 + 17),
      randomBytes(3 * 1024 * 1024),
    ];
    for (const input of inputs) {
      useAddon();
      const native = await boundary.blake3Hex(input);
      useWasm();
      const wasm = await boundary.blake3Hex(input);
      expect(native).toBe(wasm);
    }
  });

  it("hashes files identically to the wasm streaming path", async () => {
    const cases: Record<string, Buffer> = {
      "empty.bin": Buffer.alloc(0),
      "small.bin": randomBytes(100),
      // Spans multiple wasm 1 MiB chunks AND the addon's mmap path.
      "media.bin": randomBytes(3 * 1024 * 1024 + 333),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const path = join(root, name);
      writeFileSync(path, payload);
      useAddon();
      const native = await boundary.blake3HexFile(path);
      useWasm();
      const wasm = await boundary.blake3HexFile(path);
      expect(native).toBe(wasm);
      expect(native).toBe(await boundary.blake3HexWasm(payload));
    }
  });

  it("rejects on missing files like the wasm path does", async () => {
    useAddon();
    await expect(
      boundary.blake3HexFile(join(root, "never-a-file.bin")),
    ).rejects.toThrow();
    useWasm();
    await expect(
      boundary.blake3HexFile(join(root, "never-a-file.bin")),
    ).rejects.toThrow();
  });

  it("falls back to wasm when disabled, missing, or bogus", async () => {
    // Operator escape hatch.
    useAddon();
    process.env.TALON_NO_BLAKE3_NATIVE = "1";
    boundary._resetNativeBlake3ForTesting();
    expect(boundary.nativeBlake3()).toBeNull();

    // Pointed at a path with no artifact.
    process.env.TALON_BLAKE3_NODE = join(root, "missing.node");
    delete process.env.TALON_NO_BLAKE3_NATIVE;
    boundary._resetNativeBlake3ForTesting();
    expect(boundary.nativeBlake3()).toBeNull();

    // Pointed at a file that isn't a loadable addon.
    const bogus = join(root, "bogus.node");
    writeFileSync(bogus, "not a shared library");
    process.env.TALON_BLAKE3_NODE = bogus;
    boundary._resetNativeBlake3ForTesting();
    expect(boundary.nativeBlake3()).toBeNull();

    // And hashing still works end-to-end through the fallback.
    const digest = await boundary.blake3Hex("");
    expect(digest).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("keeps the event loop responsive while hashing a large file", async () => {
    useAddon();
    const path = join(root, "large.bin");
    writeFileSync(path, randomBytes(64 * 1024 * 1024));

    // Sample event-loop lag while the hash runs on the libuv pool. The
    // wasm path would block for the whole hash; the addon must keep
    // ticks flowing. Generous bound — CI machines stall for many
    // reasons, but a synchronous 64 MB hash would exceed it reliably.
    let worstLagMs = 0;
    let last = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      worstLagMs = Math.max(worstLagMs, now - last - 5);
      last = now;
    }, 5);
    try {
      const digest = await boundary.blake3HexFile(path);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      clearInterval(sampler);
    }
    expect(worstLagMs).toBeLessThan(250);
  });
});
