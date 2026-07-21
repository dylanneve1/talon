//! sqlguard — SQL input-hardening cores in Rust, compiled to
//! wasm32-unknown-unknown.
//!
//! Two escapers for model/attacker-controlled text that flows into SQLite
//! queries built by the history tools (gateway-actions get_user_messages
//! and search_history). The TypeScript consumer is src/native/sqlguard.ts;
//! both exports use alloc / dealloc (native/shared/walloc.rs) plus the
//! shared length-prefixed result-table layout decoded by
//! src/native/runtime.ts (u32 little-endian):
//!
//!   [0]  total buffer size in bytes — pass back to dealloc
//!   [1]  item count (always 1)
//!   [2]  byte length of the produced text
//!   then the produced UTF-8 bytes
//!
//! Both transforms are byte-local: they operate on bytes, and every
//! multi-byte UTF-8 sequence either passes through opaquely (its bytes
//! are never the ASCII metacharacters we act on) or is matched as a whole
//! (the whitespace table in fts_quote). So the output is byte-identical to
//! the JavaScript these replace — see src/native/sqlguard.ts and the
//! differential test in src/__tests__/native-sqlguard.test.ts.
//!
//!   escape_like  Escape the LIKE wildcards for an ESCAPE '\' clause:
//!                \ -> \\, % -> \%, _ -> \_. Used to build `%fragment%`
//!                patterns from a user-supplied name fragment. (Caller
//!                lowercases first — full-Unicode case folding stays in TS.)
//!
//!   fts_quote    Turn free-form text into an FTS5 MATCH expression: split
//!                on JS-`\s` whitespace, double-quote every token, and
//!                double any interior `"`, so FTS operators (AND, NEAR, *,
//!                ^) in the text are treated as literals, not syntax.

#![no_std]
#![warn(unsafe_op_in_unsafe_fn)]

#[path = "../../shared/walloc.rs"]
mod walloc;

/// total (u32) + item count (u32) + one item length (u32)
const HEADER_BYTES: usize = 12;

/// Allocate a result table sized for `out_len` body bytes, write the
/// header, and return (table pointer for the host, body cursor). None on
/// allocation failure.
///
/// # Safety
/// The returned body region is exactly `out_len` bytes; callers must
/// write no more than that.
unsafe fn open_result(out_len: usize) -> Option<(*mut u8, *mut u8)> {
    let total = HEADER_BYTES + out_len;
    let buf = walloc::walloc_alloc(total);
    if buf.is_null() {
        return None;
    }
    // Little-endian header, matching the result-table contract in
    // runtime.ts.
    let header = unsafe { core::slice::from_raw_parts_mut(buf, HEADER_BYTES) };
    header[0..4].copy_from_slice(&(total as u32).to_le_bytes());
    header[4..8].copy_from_slice(&1u32.to_le_bytes()); // item count
    header[8..12].copy_from_slice(&(out_len as u32).to_le_bytes());
    Some((buf, unsafe { buf.add(HEADER_BYTES) }))
}

// ── escape_like ─────────────────────────────────────────────────────────

fn like_needs_escape(c: u8) -> bool {
    c == b'\\' || c == b'%' || c == b'_'
}

/// # Safety
/// `input` must be valid for reads of `len` bytes (null only alongside
/// `len == 0`).
#[export_name = "escape_like"]
pub unsafe extern "C" fn escape_like(input: *const u8, len: usize) -> u32 {
    let input = if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(input, len) }
    };
    let out_len = input
        .iter()
        .map(|&c| 1 + usize::from(like_needs_escape(c)))
        .sum();

    let Some((buf, body)) = (unsafe { open_result(out_len) }) else {
        return 0;
    };
    let out = unsafe { core::slice::from_raw_parts_mut(body, out_len) };
    let mut at = 0;
    for &c in input {
        if like_needs_escape(c) {
            out[at] = b'\\';
            at += 1;
        }
        out[at] = c;
        at += 1;
    }
    buf as usize as u32
}

// ── fts_quote ───────────────────────────────────────────────────────────

/// Byte length of the JS-`\s` whitespace character starting at s[i], or 0
/// when s[i] does not begin one. `\s` in ECMAScript is the fixed set
/// {U+0009..U+000D, U+0020} plus the Space_Separator (Zs) category
/// {U+00A0, U+1680, U+2000..U+200A, U+202F, U+205F, U+3000} plus the line
/// terminators {U+2028, U+2029} and U+FEFF. It is NOT affected by the `u`
/// flag and does not change with Unicode versions — a fixed table, matched
/// as whole UTF-8 byte sequences so no decoder is needed.
fn ws_len(s: &[u8], i: usize) -> usize {
    let len = s.len();
    let b = s[i];
    if matches!(b, 0x09..=0x0D | 0x20) {
        return 1; // U+0009..U+000D, U+0020
    }
    if b == 0xC2 && i + 1 < len && s[i + 1] == 0xA0 {
        return 2; // U+00A0
    }
    if b == 0xE1 && i + 2 < len && s[i + 1] == 0x9A && s[i + 2] == 0x80 {
        return 3; // U+1680
    }
    if b == 0xE2 && i + 2 < len && s[i + 1] == 0x80 {
        let c = s[i + 2];
        if (0x80..=0x8A).contains(&c) {
            return 3; // U+2000..U+200A
        }
        if c == 0xA8 || c == 0xA9 || c == 0xAF {
            return 3; // U+2028, U+2029, U+202F
        }
    }
    if b == 0xE2 && i + 2 < len && s[i + 1] == 0x81 && s[i + 2] == 0x9F {
        return 3; // U+205F
    }
    if b == 0xE3 && i + 2 < len && s[i + 1] == 0x80 && s[i + 2] == 0x80 {
        return 3; // U+3000
    }
    if b == 0xEF && i + 2 < len && s[i + 1] == 0xBB && s[i + 2] == 0xBF {
        return 3; // U+FEFF
    }
    0
}

/// # Safety
/// `input` must be valid for reads of `len` bytes (null only alongside
/// `len == 0`).
#[export_name = "fts_quote"]
pub unsafe extern "C" fn fts_quote(input: *const u8, len: usize) -> u32 {
    let input = if len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(input, len) }
    };

    // Pass 1: measure. A token is a maximal run of non-whitespace bytes;
    // leading/trailing/repeated whitespace collapses (JS filter(Boolean)).
    let mut out_len = 0usize;
    let mut tokens = 0u32;
    let mut i = 0usize;
    while i < input.len() {
        let w = ws_len(input, i);
        if w > 0 {
            i += w;
            continue;
        }
        if tokens > 0 {
            out_len += 1; // separator space between tokens
        }
        tokens += 1;
        out_len += 2; // surrounding quotes
        while i < input.len() {
            if ws_len(input, i) > 0 {
                break;
            }
            out_len += if input[i] == b'"' { 2 } else { 1 }; // interior quote doubled
            i += 1;
        }
    }

    let Some((buf, body)) = (unsafe { open_result(out_len) }) else {
        return 0;
    };
    let out = unsafe { core::slice::from_raw_parts_mut(body, out_len) };

    // Pass 2: write, identical traversal.
    let mut emitted = 0u32;
    let mut at = 0usize;
    i = 0;
    while i < input.len() {
        let w = ws_len(input, i);
        if w > 0 {
            i += w;
            continue;
        }
        if emitted > 0 {
            out[at] = b' ';
            at += 1;
        }
        emitted += 1;
        out[at] = b'"';
        at += 1;
        while i < input.len() {
            if ws_len(input, i) > 0 {
                break;
            }
            let c = input[i];
            if c == b'"' {
                out[at] = b'"';
                out[at + 1] = b'"';
                at += 2;
            } else {
                out[at] = c;
                at += 1;
            }
            i += 1;
        }
        out[at] = b'"';
        at += 1;
    }
    buf as usize as u32
}
