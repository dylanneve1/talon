//! BLAKE3 hashing for WebAssembly with a minimal C ABI.
//!
//! No wasm-bindgen: the host (Talon's TypeScript boundary,
//! `src/native/blake3.ts`) talks to this module through three raw exports
//! plus the standard exported linear `memory`. Keeping the surface to
//! plain integers means the artifact needs zero generated JS glue and can
//! be instantiated from embedded bytes in any engine (Node, bun,
//! bun-compiled binaries).
//!
//! # ABI contract
//!
//! - `alloc(len: usize) -> *mut u8`
//!   Allocate `len` bytes of wasm linear memory and return the offset.
//!   Returns 0 (null) when `len == 0`. The host must treat the returned
//!   region as uninitialized and must release it with `dealloc` using the
//!   *same* `len`.
//!
//! - `dealloc(ptr: *mut u8, len: usize)`
//!   Release a region previously returned by `alloc(len)`. Passing
//!   `ptr == 0` or `len == 0` is a no-op, mirroring `alloc(0)`.
//!
//! - `blake3_hash(ptr: *const u8, len: usize, out_ptr: *mut u8)`
//!   Hash the `len` input bytes at `ptr` and write the 32-byte BLAKE3
//!   digest to `out_ptr`. `out_ptr` must point at a host-allocated region
//!   of at least 32 bytes. `ptr` may be 0 only when `len == 0` (the empty
//!   input). Input and output regions must not overlap.
//!
//! Incremental hashing (streaming inputs that don't fit in memory):
//!
//! - `hasher_new() -> handle`
//!   Allocate a hasher and return an opaque non-zero handle (0 on
//!   allocator exhaustion). Every handle must be consumed by exactly one
//!   `hasher_finalize` or `hasher_free`.
//!
//! - `hasher_update(handle, ptr: *const u8, len: usize)`
//!   Feed `len` bytes at `ptr` into the hasher. May be called any number
//!   of times. `ptr` may be 0 only when `len == 0`.
//!
//! - `hasher_finalize(handle, out_ptr: *mut u8)`
//!   Write the 32-byte digest to `out_ptr` and CONSUME the handle — it
//!   must not be used again.
//!
//! - `hasher_free(handle)`
//!   Consume a handle without finalizing (host-side error cleanup).
//!
//! One-shot calls keep no state between them; incremental state lives
//! behind the handle, so interleaved hashers are independent and a single
//! instance can be reused for every hash for the process lifetime.

use std::alloc::{alloc as rust_alloc, dealloc as rust_dealloc, Layout};

/// Number of bytes `blake3_hash` writes to `out_ptr`.
const OUT_LEN: usize = 32;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    // Alignment 1: the host only ever stores raw byte buffers here.
    let layout = Layout::from_size_align(len, 1).expect("invalid alloc layout");
    // SAFETY: layout has non-zero size (len > 0 checked above).
    unsafe { rust_alloc(layout) }
}

/// # Safety
/// `ptr` must come from `alloc(len)` with this exact `len`, and must not
/// be used after this call.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    let layout = Layout::from_size_align(len, 1).expect("invalid dealloc layout");
    rust_dealloc(ptr, layout);
}

/// # Safety
/// `ptr` must be valid for reads of `len` bytes (or null when `len == 0`),
/// `out_ptr` must be valid for writes of 32 bytes, and the regions must
/// not overlap.
#[no_mangle]
pub unsafe extern "C" fn blake3_hash(ptr: *const u8, len: usize, out_ptr: *mut u8) {
    let input: &[u8] = if len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len)
    };
    let hash = blake3::hash(input);
    core::ptr::copy_nonoverlapping(hash.as_bytes().as_ptr(), out_ptr, OUT_LEN);
}

// ── Incremental hashing ─────────────────────────────────────────────────────
//
// Handles are `Box<blake3::Hasher>` pointers passed as plain integers so
// the ABI surface stays FFI-safe ints. The hasher's state is fixed-size;
// `update` never allocates, so linear memory cannot grow (and host views
// cannot detach) between a host-side `alloc` and the `update` that reads
// from it.

/// Allocate an incremental hasher; returns an opaque handle (0 on
/// allocator exhaustion). Consume with `hasher_finalize` or `hasher_free`.
#[no_mangle]
pub extern "C" fn hasher_new() -> usize {
    Box::into_raw(Box::new(blake3::Hasher::new())) as usize
}

/// # Safety
/// `handle` must come from `hasher_new` and not yet be consumed; `ptr`
/// must be valid for reads of `len` bytes (or null when `len == 0`).
#[no_mangle]
pub unsafe extern "C" fn hasher_update(handle: usize, ptr: *const u8, len: usize) {
    if handle == 0 || len == 0 {
        return;
    }
    let hasher = &mut *(handle as *mut blake3::Hasher);
    hasher.update(core::slice::from_raw_parts(ptr, len));
}

/// # Safety
/// `handle` must come from `hasher_new` and not yet be consumed; `out_ptr`
/// must be valid for writes of 32 bytes. Consumes the handle.
#[no_mangle]
pub unsafe extern "C" fn hasher_finalize(handle: usize, out_ptr: *mut u8) {
    if handle == 0 {
        return;
    }
    let hasher = Box::from_raw(handle as *mut blake3::Hasher);
    let hash = hasher.finalize();
    core::ptr::copy_nonoverlapping(hash.as_bytes().as_ptr(), out_ptr, OUT_LEN);
}

/// # Safety
/// `handle` must come from `hasher_new` and not yet be consumed. Consumes
/// the handle without producing a digest (error-path cleanup).
#[no_mangle]
pub unsafe extern "C" fn hasher_free(handle: usize) {
    if handle == 0 {
        return;
    }
    drop(Box::from_raw(handle as *mut blake3::Hasher));
}
