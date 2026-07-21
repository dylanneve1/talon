//! walloc — shared linear-memory allocator for Talon's `no_std` wasm
//! modules (strsim, sqlguard, htmlents).
//!
//! Implements the `alloc` / `dealloc` half of the native-plane ABI
//! (see src/native/runtime.ts): alloc(0) == 0, alloc returns 0 on
//! exhaustion, dealloc(0, _) and dealloc(_, 0) are no-ops.
//!
//! Design: a bump allocator over [__heap_base, memory end) with a live
//! counter. The JS wrappers make fully balanced alloc/dealloc pairs
//! within one synchronous call — nothing survives across calls — so
//! when the last live region is released the bump pointer rewinds to
//! the heap base in one step. O(1) alloc, O(1) dealloc, zero metadata.
//!
//! NOT suitable for modules that hold allocations across calls
//! (streaming handles etc.) — those need a real allocator, like the
//! Rust std one in native/blake3-wasm.
//!
//! Included per crate via `#[path = "../../shared/walloc.rs"] mod
//! walloc;` — the Rust spelling of the old single-translation-unit
//! walloc.h include. Each including crate therefore carries exactly one
//! allocator and one panic handler (panics lower to `unreachable`; the
//! module code is written panic-free, so the handler is dead weight of
//! a few bytes, not a code path).

use core::arch::wasm32;

const PAGE_BYTES: usize = 65536;
const ALIGN: usize = 8;

// First byte past static data + shadow stack, provided by wasm-ld.
unsafe extern "C" {
    static __heap_base: u8;
}

/// Next free offset; 0 = not yet initialized.
static mut TOP: usize = 0;
/// Live allocation count.
static mut LIVE: u32 = 0;

fn heap_base() -> usize {
    core::ptr::addr_of!(__heap_base) as usize
}

#[export_name = "alloc"]
pub extern "C" fn walloc_alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return core::ptr::null_mut();
    }
    unsafe {
        if TOP == 0 {
            TOP = heap_base();
        }
        let ptr = (TOP + (ALIGN - 1)) & !(ALIGN - 1);
        let end = match ptr.checked_add(len) {
            Some(end) => end, // address-space overflow otherwise
            None => return core::ptr::null_mut(),
        };
        let have = wasm32::memory_size(0) * PAGE_BYTES;
        if end > have {
            let need = (end - have).div_ceil(PAGE_BYTES);
            if wasm32::memory_grow(0, need) == usize::MAX {
                return core::ptr::null_mut();
            }
        }
        TOP = end;
        LIVE = LIVE.wrapping_add(1);
        ptr as *mut u8
    }
}

#[export_name = "dealloc"]
pub extern "C" fn walloc_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() || len == 0 {
        return;
    }
    unsafe {
        if LIVE > 0 {
            LIVE -= 1;
            if LIVE == 0 {
                TOP = heap_base();
            }
        }
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}
