/*
 * htmlents — HTML entity escaping in C++, compiled to wasm32-freestanding
 * (-fno-exceptions -fno-rtti, no standard library).
 *
 * One single-pass escaper for Telegram HTML parse mode, replacing the
 * five chained regex passes in the JS escapeHtml it supersedes. Every
 * outbound Telegram render flows through here (frontend/telegram/
 * formatting.ts via src/native/htmlents.ts).
 *
 * ABI: alloc / dealloc (native/shared/walloc.h) plus `escape_html`,
 * which returns the shared length-prefixed result-table layout decoded
 * by src/native/runtime.ts (u32 little-endian):
 *
 *   [0]  total buffer size in bytes — pass back to dealloc
 *   [1]  item count (always 1)
 *   [2]  byte length of the escaped text
 *   then the escaped UTF-8 bytes
 *
 * Escaped characters — exactly the set the JS implementation handled,
 * in HTML-attribute-safe form: & < > " '. All other bytes (including
 * multi-byte UTF-8 sequences, which never contain ASCII values) pass
 * through untouched, so the transform is byte-local and allocation is
 * exact: pass 1 measures, pass 2 writes.
 */

#include <stddef.h>
#include <stdint.h>

#include "../../shared/walloc.h"

namespace {

struct Entity {
  const char *text;
  uint32_t len;
};

/// Replacement for one byte, or nullptr when it passes through.
const Entity *entityFor(uint8_t c) {
  static constexpr Entity kAmp = {"&amp;", 5};
  static constexpr Entity kLt = {"&lt;", 4};
  static constexpr Entity kGt = {"&gt;", 4};
  static constexpr Entity kQuot = {"&quot;", 6};
  static constexpr Entity kApos = {"&#39;", 5};
  switch (c) {
    case '&':
      return &kAmp;
    case '<':
      return &kLt;
    case '>':
      return &kGt;
    case '"':
      return &kQuot;
    case '\'':
      return &kApos;
    default:
      return nullptr;
  }
}

/// Bounds-unchecked forward writer — callers size the buffer exactly
/// (pass 1) before writing (pass 2).
class ByteWriter {
 public:
  explicit ByteWriter(uint8_t *out) : out_(out) {}

  void u32(uint32_t value) {
    // Little-endian, byte by byte: the buffer is 8-aligned (walloc)
    // but staying byte-wise keeps the layout contract explicit.
    out_[0] = static_cast<uint8_t>(value);
    out_[1] = static_cast<uint8_t>(value >> 8);
    out_[2] = static_cast<uint8_t>(value >> 16);
    out_[3] = static_cast<uint8_t>(value >> 24);
    out_ += 4;
  }

  void byte(uint8_t b) { *out_++ = b; }

  void entity(const Entity &e) {
    for (uint32_t i = 0; i < e.len; i++) {
      *out_++ = static_cast<uint8_t>(e.text[i]);
    }
  }

 private:
  uint8_t *out_;
};

constexpr size_t kHeaderBytes = 12; /* total + count + one item length */

}  // namespace

extern "C" __attribute__((export_name("escape_html"))) uint32_t escape_html(
    const uint8_t *in, size_t len) {
  size_t out_len = 0;
  for (size_t i = 0; i < len; i++) {
    const Entity *e = entityFor(in[i]);
    out_len += e ? e->len : 1u;
  }

  const size_t total = kHeaderBytes + out_len;
  uint8_t *buf = static_cast<uint8_t *>(walloc_alloc(total));
  if (buf == nullptr) return 0;

  ByteWriter w(buf);
  w.u32(static_cast<uint32_t>(total));
  w.u32(1u); /* item count */
  w.u32(static_cast<uint32_t>(out_len));
  for (size_t i = 0; i < len; i++) {
    const Entity *e = entityFor(in[i]);
    if (e != nullptr) {
      w.entity(*e);
    } else {
      w.byte(in[i]);
    }
  }
  return static_cast<uint32_t>(reinterpret_cast<size_t>(buf));
}
