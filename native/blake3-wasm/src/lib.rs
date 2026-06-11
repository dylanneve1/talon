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
//! Calls are synchronous and the module keeps no state between them, so a
//! single instance can be reused for every hash for the process lifetime.

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
