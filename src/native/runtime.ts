/**
 * Embedded-wasm runtime — the one place that knows how Talon's native
 * modules cross the JS boundary.
 *
 * Every wasm module in the native plane (Rust blake3, Zig textops,
 * C strsim, C++ htmlents) follows the same contract:
 *
 *   - The artifact ships as base64 inside a generated `*-bytes.ts`
 *     module, so it survives `bun build --compile` single binaries —
 *     no fs paths or import.meta.url asset resolution.
 *   - The module exports a raw C ABI over linear memory with a common
 *     core: `memory`, `alloc(len)`, `dealloc(ptr, len)`. `alloc`
 *     returns 0 for len == 0 and on allocator exhaustion.
 *   - Multi-value results come back as a length-prefixed table
 *     (u32 little-endian): [0] total buffer size in bytes (pass back
 *     to dealloc), [1] item count N, [2..2+N] byte length of each
 *     item, then the item bytes concatenated.
 *
 * This module owns that contract once: lazy single instantiation,
 * guarded input staging, and result-table decoding. Wrappers own only
 * their module's specific exports and semantics.
 *
 * Memory discipline (shared by all wrappers): allocate every region
 * BEFORE taking any memory views — alloc may grow linear memory, which
 * detaches existing ArrayBuffer views — and release every region
 * before returning, on the error path too.
 */

/** The C-ABI core every embedded wasm module exports. */
export interface WasmCoreExports {
  memory: WebAssembly.Memory;
  /** Returns the region offset, or 0 for len == 0 / exhaustion. */
  alloc(len: number): number;
  /** Release a region from `alloc` — same len. (0, *) is a no-op. */
  dealloc(ptr: number, len: number): void;
}

/**
 * A lazily-instantiated embedded wasm module. `instance()` is for
 * small modules where synchronous compilation keeps wrapper call
 * signatures sync; `load()` compiles off the main thread.
 */
export interface EmbeddedWasm<T extends WasmCoreExports> {
  /** Decoded artifact size — provenance for doctor, no decode needed. */
  readonly sizeBytes: number;
  /** Synchronous lazy singleton instance. */
  instance(): T;
  /** Asynchronous lazy singleton instance. */
  load(): Promise<T>;
}

/** Decoded byte length of a base64 string without materializing it. */
export function base64ByteLength(b64: string): number {
  let padding = 0;
  if (b64.endsWith("==")) padding = 2;
  else if (b64.endsWith("=")) padding = 1;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Wrap an embedded base64 artifact as a lazily-instantiated module.
 * Decoding and compiling happen at most once, on first use — module
 * import stays side-effect free for consumers that never call in.
 * The sync and async paths share the one instance: whichever runs
 * first wins, the other reuses it.
 */
export function embeddedWasm<T extends WasmCoreExports>(
  base64: string,
): EmbeddedWasm<T> {
  let cached: T | null = null;
  let pending: Promise<T> | null = null;

  const instantiateSync = (): T => {
    const bytes = Buffer.from(base64, "base64");
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(bytes),
      {},
    );
    return instance.exports as unknown as T;
  };

  return {
    sizeBytes: base64ByteLength(base64),
    instance() {
      if (!cached) cached = instantiateSync();
      return cached;
    },
    load() {
      if (cached) return Promise.resolve(cached);
      if (!pending) {
        const bytes = Buffer.from(base64, "base64");
        pending = WebAssembly.instantiate(bytes, {}).then((result) => {
          cached = result.instance.exports as unknown as T;
          return cached;
        });
      }
      return pending;
    },
  };
}

/** UTF-8 encode a string, or pass bytes through untouched. */
export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

/**
 * Allocate a region for `bytes` and return its pointer WITHOUT writing
 * — callers that stage multiple inputs must finish all allocs before
 * any `writeRegion`, because a later alloc may grow memory and detach
 * views. Returns 0 for empty input (the ABI's null pointer, which
 * every module accepts alongside len == 0). Throws on exhaustion.
 */
export function allocRegion(
  wasm: WasmCoreExports,
  byteLength: number,
  what: string,
): number {
  const ptr = wasm.alloc(byteLength);
  if (ptr === 0 && byteLength > 0) {
    throw new Error(`${what}: wasm allocation failed (${byteLength} bytes)`);
  }
  return ptr;
}

/** Copy bytes into a region from `allocRegion`. No-op for empty input. */
export function writeRegion(
  wasm: WasmCoreExports,
  ptr: number,
  bytes: Uint8Array,
): void {
  if (bytes.length === 0) return;
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
}

/**
 * Decode a length-prefixed result table (the shared multi-value return
 * convention) into UTF-8-decoded strings, then release the buffer.
 * `ptr` must be a non-zero table pointer returned by the module.
 */
export function consumeResultTable(
  wasm: WasmCoreExports,
  ptr: number,
): string[] {
  let totalBytes = 0;
  try {
    const view = new DataView(wasm.memory.buffer);
    totalBytes = view.getUint32(ptr, true);
    const count = view.getUint32(ptr + 4, true);
    const decoder = new TextDecoder();
    const items: string[] = [];
    let offset = ptr + 4 * (2 + count);
    for (let i = 0; i < count; i++) {
      const len = view.getUint32(ptr + 4 * (2 + i), true);
      items.push(
        decoder.decode(new Uint8Array(wasm.memory.buffer, offset, len)),
      );
      offset += len;
    }
    return items;
  } finally {
    wasm.dealloc(ptr, totalBytes);
  }
}
