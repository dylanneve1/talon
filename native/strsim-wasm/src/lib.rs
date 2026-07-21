//! strsim — string-similarity core in Rust, compiled to
//! wasm32-unknown-unknown.
//!
//! Powers "did you mean ...?" suggestions for unknown Telegram slash
//! commands and unknown CLI subcommands. The TypeScript consumer is
//! src/native/strsim.ts; the ABI is alloc / dealloc (native/shared/
//! walloc.rs) plus `levenshtein` over linear memory — see README.md for
//! the contract.
//!
//! Distance is computed over bytes. Inputs are UTF-8, and for the ASCII
//! identifiers this module exists for (command names, subcommands,
//! model ids) byte distance equals character distance. Non-ASCII text
//! weighs a substituted codepoint as up to 4 edits — acceptable for
//! ranking, documented at the wrapper.
//!
//! The DP uses one statically-allocated row (two-row trick folded into
//! one row + a diagonal carry), so `levenshtein` itself never touches
//! the allocator. Strings longer than MAX_LEN return the OVERFLOW
//! sentinel instead of a distance — the wrapper maps that to
//! "no match" / a thrown error.

#![no_std]
#![warn(unsafe_op_in_unsafe_fn)]

#[path = "../../shared/walloc.rs"]
mod walloc;

const MAX_LEN: usize = 1024;
const OVERFLOW: u32 = 0xFFFF_FFFF;

static mut ROW: [u32; MAX_LEN + 1] = [0; MAX_LEN + 1];

/// # Safety
/// `a` must be valid for reads of `a_len` bytes and `b` for `b_len`
/// bytes (null only alongside a zero length). Single-threaded wasm:
/// the static DP row is never aliased across concurrent calls.
#[export_name = "levenshtein"]
pub unsafe extern "C" fn levenshtein(
    a: *const u8,
    a_len: usize,
    b: *const u8,
    b_len: usize,
) -> u32 {
    if a_len > MAX_LEN || b_len > MAX_LEN {
        return OVERFLOW;
    }
    if a_len == 0 {
        return b_len as u32;
    }
    if b_len == 0 {
        return a_len as u32;
    }
    let a = unsafe { core::slice::from_raw_parts(a, a_len) };
    let b = unsafe { core::slice::from_raw_parts(b, b_len) };
    let row = unsafe { &mut *core::ptr::addr_of_mut!(ROW) };

    for (j, cell) in row.iter_mut().enumerate().take(b_len + 1) {
        *cell = j as u32;
    }
    for (i, &ac) in a.iter().enumerate() {
        let mut diag = row[0]; // D(i-1, j-1)
        row[0] = (i + 1) as u32;
        for (j, &bc) in b.iter().enumerate() {
            let above = row[j + 1]; // D(i-1, j)
            let mut best = diag + u32::from(ac != bc);
            let del = above + 1;
            let ins = row[j] + 1;
            if del < best {
                best = del;
            }
            if ins < best {
                best = ins;
            }
            row[j + 1] = best;
            diag = above;
        }
    }
    row[b_len]
}
