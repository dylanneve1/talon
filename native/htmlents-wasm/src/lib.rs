//! htmlents — HTML entity escaping in Rust, compiled to
//! wasm32-unknown-unknown (`no_std`, allocator shared with the other
//! guard modules).
//!
//! One single-pass escaper for Telegram HTML parse mode, replacing the
//! five chained regex passes in the JS escapeHtml it superseded. Every
//! outbound Telegram render flows through here (frontend/telegram/
//! formatting.ts via src/native/htmlents.ts).
//!
//! ABI: alloc / dealloc (native/shared/walloc.rs) plus `escape_html`,
//! which returns the shared length-prefixed result-table layout decoded
//! by src/native/runtime.ts (u32 little-endian):
//!
//!   [0]  total buffer size in bytes — pass back to dealloc
//!   [1]  item count (always 1)
//!   [2]  byte length of the escaped text
//!   then the escaped UTF-8 bytes
//!
//! Escaped characters — exactly the set the JS implementation handled,
//! in HTML-attribute-safe form: & < > " '. All other bytes (including
//! multi-byte UTF-8 sequences, which never contain ASCII values) pass
//! through untouched, so the transform is byte-local and allocation is
//! exact: pass 1 measures, pass 2 writes.

#![no_std]
#![warn(unsafe_op_in_unsafe_fn)]

#[path = "../../shared/walloc.rs"]
mod walloc;

/// total (u32) + item count (u32) + one item length (u32)
const HEADER_BYTES: usize = 12;

/// Replacement for one byte, or None when it passes through.
fn entity_for(c: u8) -> Option<&'static [u8]> {
    match c {
        b'&' => Some(b"&amp;"),
        b'<' => Some(b"&lt;"),
        b'>' => Some(b"&gt;"),
        b'"' => Some(b"&quot;"),
        b'\'' => Some(b"&#39;"),
        _ => None,
    }
}

/// # Safety
/// `input` must be valid for reads of `len` bytes (null only alongside
/// `len == 0`).
#[export_name = "escape_html"]
pub unsafe extern "C" fn escape_html(input: *const u8, len: usize) -> u32 {
    let input = if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(input, len) }
    };
    let out_len: usize = input
        .iter()
        .map(|&c| entity_for(c).map_or(1, <[u8]>::len))
        .sum();

    let total = HEADER_BYTES + out_len;
    let buf = walloc::walloc_alloc(total);
    if buf.is_null() {
        return 0;
    }
    let out = unsafe { core::slice::from_raw_parts_mut(buf, total) };
    // Little-endian header, matching the result-table contract in
    // runtime.ts.
    out[0..4].copy_from_slice(&(total as u32).to_le_bytes());
    out[4..8].copy_from_slice(&1u32.to_le_bytes()); // item count
    out[8..12].copy_from_slice(&(out_len as u32).to_le_bytes());

    let mut at = HEADER_BYTES;
    for &c in input {
        match entity_for(c) {
            Some(entity) => {
                out[at..at + entity.len()].copy_from_slice(entity);
                at += entity.len();
            }
            None => {
                out[at] = c;
                at += 1;
            }
        }
    }
    buf as usize as u32
}
