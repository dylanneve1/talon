//! Message splitting for chat platform character limits.
//!
//! One hardened implementation of "split this reply into chunks the
//! platform will accept" shared by every frontend (Telegram 4096,
//! Discord 2000, Teams adaptive cards). The TypeScript consumer is
//! src/native/textops.ts; the ABI is alloc / dealloc / split_message
//! over linear memory — see README.md for the full contract.
//!
//! Semantics (deliberately matching the JS implementations this
//! replaces, then fixing their shared bugs):
//!
//!   - `max_units` counts UTF-16 code units, because that is what the
//!     platform limits and the previous `String.prototype.length`
//!     arithmetic measure. Input/output cross the boundary as UTF-8.
//!   - Split points prefer "\n\n", then "\n", then " "; a candidate is
//!     rejected when it sits in the first 30% of the budget (same
//!     heuristic the JS versions used). Otherwise: hard cut.
//!   - Hard cuts land on codepoint boundaries — never inside what JS
//!     would store as a surrogate pair (old Telegram splitter bug).
//!   - With the fence flag set, ``` fences are tracked line-by-line;
//!     a chunk that would strand an open fence is closed with "\n```"
//!     and the next chunk reopens with "```\n". Budget is reserved for
//!     the markers, so decorated chunks still fit `max_units` (old
//!     Discord splitter could overflow the limit by 4).

const std = @import("std");

const gpa = std.heap.wasm_allocator;

const FENCE_OPEN = "```\n"; // prepended when a chunk continues an open fence
const FENCE_CLOSE = "\n```"; // appended when a chunk strands an open fence
const FLAG_FENCE_AWARE: u32 = 1;

// ── ABI ─────────────────────────────────────────────────────────────────────

/// Allocate `len` bytes; returns the offset, or 0 for len == 0 /
/// allocator exhaustion. Region contents are uninitialized.
export fn alloc(len: usize) usize {
    if (len == 0) return 0;
    const mem = gpa.alloc(u8, len) catch return 0;
    return @intFromPtr(mem.ptr);
}

/// Release a region from `alloc` — must be called with the same `len`.
/// ptr == 0 or len == 0 is a no-op.
export fn dealloc(ptr: usize, len: usize) void {
    if (ptr == 0 or len == 0) return;
    const p: [*]u8 = @ptrFromInt(ptr);
    gpa.free(p[0..len]);
}

/// Split UTF-8 text at (in_ptr, in_len) into chunks of at most
/// `max_units` UTF-16 code units. Returns the offset of a result
/// buffer, or 0 on allocation failure. Layout (u32 little-endian):
///
///   [0]      total buffer size in bytes — pass back to dealloc
///   [1]      chunk count N
///   [2..2+N] byte length of each chunk
///   then the chunk bytes, concatenated
export fn split_message(
    in_ptr: usize,
    in_len: usize,
    max_units: u32,
    flags: u32,
) usize {
    const input: []const u8 = if (in_len == 0)
        &[_]u8{}
    else blk: {
        const p: [*]const u8 = @ptrFromInt(in_ptr);
        break :blk p[0..in_len];
    };
    const max: usize = @max(max_units, 1);
    const fence_aware = (flags & FLAG_FENCE_AWARE) != 0;

    // Pass 1: count chunks and output bytes. The iterator is
    // deterministic, so a second pass reproduces the same chunks —
    // which avoids growable containers for the unknown chunk count.
    var counter = ChunkIter.init(input, max, fence_aware);
    var count: usize = 0;
    var body_bytes: usize = 0;
    while (counter.next()) |chunk| {
        count += 1;
        body_bytes += chunk.totalLen();
    }

    const header = 4 * (2 + count);
    const total = header + body_bytes;
    const buf = gpa.alloc(u8, total) catch return 0;
    writeU32(buf, 0, total);
    writeU32(buf, 4, count);

    // Pass 2: write lengths and bytes.
    var writer = ChunkIter.init(input, max, fence_aware);
    var index: usize = 0;
    var offset = header;
    while (writer.next()) |chunk| {
        writeU32(buf, 4 * (2 + index), chunk.totalLen());
        offset += chunk.write(buf[offset..]);
        index += 1;
    }
    return @intFromPtr(buf.ptr);
}

fn writeU32(buf: []u8, offset: usize, value: usize) void {
    std.mem.writeInt(u32, buf[offset..][0..4], @intCast(value), .little);
}

// ── Chunking ────────────────────────────────────────────────────────────────

const Chunk = struct {
    /// Reopen marker ("```\n") — chunk continues a fence from the
    /// previous chunk.
    prefix: bool,
    body: []const u8,
    /// Close marker ("\n```") — chunk would otherwise strand an open
    /// fence.
    close: bool,

    fn totalLen(self: Chunk) usize {
        var len = self.body.len;
        if (self.prefix) len += FENCE_OPEN.len;
        if (self.close) len += FENCE_CLOSE.len;
        return len;
    }

    fn write(self: Chunk, out: []u8) usize {
        var offset: usize = 0;
        if (self.prefix) {
            @memcpy(out[offset..][0..FENCE_OPEN.len], FENCE_OPEN);
            offset += FENCE_OPEN.len;
        }
        @memcpy(out[offset..][0..self.body.len], self.body);
        offset += self.body.len;
        if (self.close) {
            @memcpy(out[offset..][0..FENCE_CLOSE.len], FENCE_CLOSE);
            offset += FENCE_CLOSE.len;
        }
        return offset;
    }
};

const ChunkIter = struct {
    rest: []const u8,
    max_units: usize,
    fence_aware: bool,
    open_fence: bool = false,
    first: bool = true,
    done: bool = false,

    fn init(input: []const u8, max_units: usize, fence_aware: bool) ChunkIter {
        return .{ .rest = input, .max_units = max_units, .fence_aware = fence_aware };
    }

    fn next(self: *ChunkIter) ?Chunk {
        if (self.done) return null;

        const prefix = self.fence_aware and self.open_fence;
        const prefix_units: usize = if (prefix) FENCE_OPEN.len else 0;

        // Everything left fits: emit it as the final chunk (no close —
        // the original text owns its own trailing fence state). A text
        // that fit without any splitting is returned verbatim; once
        // splitting happened, the final chunk is end-trimmed like every
        // other chunk, so a split that ate the last separator doesn't
        // leave trailing whitespace behind.
        const tail = if (self.first) self.rest else trimEnd(self.rest);
        self.first = false;
        if (utf16Len(tail) + prefix_units <= self.max_units) {
            self.done = true;
            return .{ .prefix = prefix, .body = tail, .close = false };
        }

        const budget = @max(self.max_units -| prefix_units, 1);
        var cut = findSplit(self.rest, budget, self.max_units);
        var body = trimEnd(self.rest[0..cut]);

        var close = false;
        if (self.fence_aware) {
            var still_open = self.strandsOpenFence(body);
            if (still_open and budget > FENCE_CLOSE.len) {
                // The chunk needs a close marker appended — re-split
                // with room reserved for it so the decorated chunk
                // still fits max_units. The shorter cut can land before
                // the fence opener entirely, so recheck.
                cut = findSplit(self.rest, budget - FENCE_CLOSE.len, self.max_units);
                body = trimEnd(self.rest[0..cut]);
                still_open = self.strandsOpenFence(body);
            }
            close = still_open;
            self.open_fence = still_open;
        }

        self.rest = trimStart(self.rest[cut..]);
        if (self.rest.len == 0) self.done = true;
        return .{ .prefix = prefix, .body = body, .close = close };
    }

    /// Would emitting `body` as the next chunk leave a ``` fence open?
    fn strandsOpenFence(self: *const ChunkIter, body: []const u8) bool {
        return self.open_fence != (fenceToggles(body) % 2 == 1);
    }
};

const Candidate = struct {
    bytes: usize = 0,
    units: usize = 0,
    found: bool = false,
};

/// Byte length to cut from `rest` so the cut body is at most
/// `budget_units` UTF-16 code units. Prefers the last "\n\n", then
/// "\n", then " " whose position clears the 30%-of-max threshold;
/// falls back to a hard cut on a codepoint boundary. Always ≥ 1
/// codepoint so the caller makes progress.
fn findSplit(rest: []const u8, budget_units: usize, max_units: usize) usize {
    var para = Candidate{};
    var line = Candidate{};
    var space = Candidate{};
    var hard: usize = 0;

    var b: usize = 0;
    var u: usize = 0;
    while (b < rest.len and u <= budget_units) {
        const len = @min(cpLen(rest[b]), rest.len - b);
        const units: usize = if (len == 4) 2 else 1;
        switch (rest[b]) {
            '\n' => {
                if (b + 1 < rest.len and rest[b + 1] == '\n')
                    para = .{ .bytes = b, .units = u, .found = true };
                line = .{ .bytes = b, .units = u, .found = true };
            },
            ' ' => space = .{ .bytes = b, .units = u, .found = true },
            else => {},
        }
        if (u + units <= budget_units) hard = b + len;
        b += len;
        u += units;
    }

    if (clearsThreshold(para, max_units)) return para.bytes;
    if (clearsThreshold(line, max_units)) return line.bytes;
    if (clearsThreshold(space, max_units)) return space.bytes;
    // Hard cut. hard == 0 means even the first codepoint overflows the
    // budget (e.g. an astral codepoint against budget 1): take it
    // anyway rather than loop forever.
    if (hard == 0) hard = @min(cpLen(rest[0]), rest.len);
    return hard;
}

/// The JS versions rejected separators in the first 30% of the limit
/// (`at <= max * 0.3`) to avoid emitting a sliver chunk; integer form.
fn clearsThreshold(c: Candidate, max_units: usize) bool {
    return c.found and c.units * 10 > max_units * 3;
}

// ── Text measurement ────────────────────────────────────────────────────────

/// Byte length of the UTF-8 sequence starting at `b`. Continuation or
/// invalid lead bytes count as 1 so malformed input still terminates.
fn cpLen(b: u8) usize {
    if (b < 0xC0) return 1;
    if (b < 0xE0) return 2;
    if (b < 0xF0) return 3;
    return 4;
}

/// UTF-16 code units of a UTF-8 slice: astral codepoints (4-byte
/// UTF-8) become surrogate pairs, everything else is one unit.
fn utf16Len(s: []const u8) usize {
    var b: usize = 0;
    var u: usize = 0;
    while (b < s.len) {
        const len = @min(cpLen(s[b]), s.len - b);
        u += if (len == 4) 2 else 1;
        b += len;
    }
    return u;
}

fn isWhitespace(c: u8) bool {
    return switch (c) {
        ' ', '\t', '\n', '\r', 0x0b, 0x0c => true,
        else => false,
    };
}

fn trimStart(s: []const u8) []const u8 {
    var i: usize = 0;
    while (i < s.len and isWhitespace(s[i])) i += 1;
    return s[i..];
}

fn trimEnd(s: []const u8) []const u8 {
    var end = s.len;
    while (end > 0 and isWhitespace(s[end - 1])) end -= 1;
    return s[0..end];
}

// ── Fences ──────────────────────────────────────────────────────────────────

/// Number of fence-delimiter lines in `body`: lines whose first
/// non-space content starts with ``` (up to 3 leading spaces, per
/// CommonMark). Counting line starts — not raw ``` occurrences — keeps
/// inline triple-backtick runs from flipping the state (old Discord
/// splitter bug).
fn fenceToggles(body: []const u8) usize {
    var count: usize = 0;
    var line_start: usize = 0;
    while (line_start <= body.len) {
        const line_end = std.mem.indexOfScalarPos(u8, body, line_start, '\n') orelse body.len;
        const ln = body[line_start..line_end];
        var i: usize = 0;
        while (i < ln.len and i < 3 and ln[i] == ' ') i += 1;
        if (ln.len >= i + 3 and ln[i] == '`' and ln[i + 1] == '`' and ln[i + 2] == '`')
            count += 1;
        if (line_end == body.len) break;
        line_start = line_end + 1;
    }
    return count;
}
