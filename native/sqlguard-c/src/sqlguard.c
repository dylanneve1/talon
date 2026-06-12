/*
 * sqlguard — SQL input-hardening cores in C, compiled to
 * wasm32-freestanding.
 *
 * Two escapers for model/attacker-controlled text that flows into SQLite
 * queries built by the history tools (gateway-actions get_user_messages
 * and search_history). The TypeScript consumer is src/native/sqlguard.ts;
 * both exports use alloc / dealloc (native/shared/walloc.h) plus the
 * shared length-prefixed result-table layout decoded by
 * src/native/runtime.ts (u32 little-endian):
 *
 *   [0]  total buffer size in bytes — pass back to dealloc
 *   [1]  item count (always 1)
 *   [2]  byte length of the produced text
 *   then the produced UTF-8 bytes
 *
 * Both transforms are byte-local: they operate on bytes, and every
 * multi-byte UTF-8 sequence either passes through opaquely (its bytes
 * are never the ASCII metacharacters we act on) or is matched as a whole
 * (the whitespace table in fts_quote). So the output is byte-identical to
 * the JavaScript these replace — see src/native/sqlguard.ts and the
 * differential test in src/__tests__/native-sqlguard.test.ts.
 *
 *   escape_like  Escape the LIKE wildcards for an ESCAPE '\' clause:
 *                \ -> \\, % -> \%, _ -> \_. Used to build `%fragment%`
 *                patterns from a user-supplied name fragment. (Caller
 *                lowercases first — full-Unicode case folding stays in TS.)
 *
 *   fts_quote    Turn free-form text into an FTS5 MATCH expression: split
 *                on JS-`\s` whitespace, double-quote every token, and
 *                double any interior `"`, so FTS operators (AND, NEAR, *,
 *                ^) in the text are treated as literals, not syntax.
 */

#include <stddef.h>
#include <stdint.h>

#include "../../shared/walloc.h"

/* total (u32) + item count (u32) + one item length (u32) */
#define SQLGUARD_HEADER_BYTES 12u

static void put_u32(uint8_t *p, uint32_t value) {
  /* Little-endian, matching the result-table contract in runtime.ts. */
  p[0] = (uint8_t)value;
  p[1] = (uint8_t)(value >> 8);
  p[2] = (uint8_t)(value >> 16);
  p[3] = (uint8_t)(value >> 24);
}

/* Allocate a result table sized for `out_len` body bytes and write the
 * header. Returns the buffer (body cursor via *body_out) or 0 on
 * allocation failure. */
static uint8_t *open_result(size_t out_len, uint8_t **body_out) {
  const size_t total = SQLGUARD_HEADER_BYTES + out_len;
  uint8_t *buf = (uint8_t *)walloc_alloc(total);
  if (buf == 0) return 0;
  put_u32(buf, (uint32_t)total);
  put_u32(buf + 4, 1u);            /* item count */
  put_u32(buf + 8, (uint32_t)out_len);
  *body_out = buf + SQLGUARD_HEADER_BYTES;
  return buf;
}

/* ── escape_like ─────────────────────────────────────────────────────── */

static uint32_t like_needs_escape(uint8_t c) {
  return (c == '\\' || c == '%' || c == '_') ? 1u : 0u;
}

__attribute__((export_name("escape_like"))) uint32_t escape_like(
    const uint8_t *in, size_t len) {
  size_t out_len = 0;
  for (size_t i = 0; i < len; i++) {
    out_len += 1u + like_needs_escape(in[i]);
  }

  uint8_t *body;
  uint8_t *buf = open_result(out_len, &body);
  if (buf == 0) return 0;

  for (size_t i = 0; i < len; i++) {
    const uint8_t c = in[i];
    if (like_needs_escape(c)) *body++ = '\\';
    *body++ = c;
  }
  return (uint32_t)(size_t)buf;
}

/* ── fts_quote ───────────────────────────────────────────────────────── */

/*
 * Byte length of the JS-`\s` whitespace character starting at s[i], or 0
 * when s[i] does not begin one. `\s` in ECMAScript is the fixed set
 * {U+0009..U+000D, U+0020} plus the Space_Separator (Zs) category
 * {U+00A0, U+1680, U+2000..U+200A, U+202F, U+205F, U+3000} plus the line
 * terminators {U+2028, U+2029} and U+FEFF. It is NOT affected by the `u`
 * flag and does not change with Unicode versions — a fixed table, matched
 * as whole UTF-8 byte sequences so no decoder is needed.
 */
static size_t ws_len(const uint8_t *s, size_t i, size_t len) {
  const uint8_t b = s[i];
  if (b == 0x09 || b == 0x0A || b == 0x0B || b == 0x0C || b == 0x0D ||
      b == 0x20) {
    return 1; /* U+0009..U+000D, U+0020 */
  }
  if (b == 0xC2 && i + 1 < len && s[i + 1] == 0xA0) return 2; /* U+00A0 */
  if (b == 0xE1 && i + 2 < len && s[i + 1] == 0x9A && s[i + 2] == 0x80) {
    return 3; /* U+1680 */
  }
  if (b == 0xE2 && i + 2 < len && s[i + 1] == 0x80) {
    const uint8_t c = s[i + 2];
    if (c >= 0x80 && c <= 0x8A) return 3;              /* U+2000..U+200A */
    if (c == 0xA8 || c == 0xA9 || c == 0xAF) return 3; /* U+2028,2029,202F */
  }
  if (b == 0xE2 && i + 2 < len && s[i + 1] == 0x81 && s[i + 2] == 0x9F) {
    return 3; /* U+205F */
  }
  if (b == 0xE3 && i + 2 < len && s[i + 1] == 0x80 && s[i + 2] == 0x80) {
    return 3; /* U+3000 */
  }
  if (b == 0xEF && i + 2 < len && s[i + 1] == 0xBB && s[i + 2] == 0xBF) {
    return 3; /* U+FEFF */
  }
  return 0;
}

__attribute__((export_name("fts_quote"))) uint32_t fts_quote(const uint8_t *in,
                                                             size_t len) {
  /* Pass 1: measure. A token is a maximal run of non-whitespace bytes;
   * leading/trailing/repeated whitespace collapses (JS filter(Boolean)). */
  size_t out_len = 0;
  uint32_t tokens = 0;
  size_t i = 0;
  while (i < len) {
    const size_t w = ws_len(in, i, len);
    if (w) {
      i += w;
      continue;
    }
    if (tokens > 0) out_len += 1u; /* separator space between tokens */
    tokens++;
    out_len += 2u; /* surrounding quotes */
    while (i < len) {
      if (ws_len(in, i, len)) break;
      out_len += (in[i] == '"') ? 2u : 1u; /* interior quote is doubled */
      i += 1;
    }
  }

  uint8_t *body;
  uint8_t *buf = open_result(out_len, &body);
  if (buf == 0) return 0;

  /* Pass 2: write, identical traversal. */
  uint32_t emitted = 0;
  i = 0;
  while (i < len) {
    const size_t w = ws_len(in, i, len);
    if (w) {
      i += w;
      continue;
    }
    if (emitted > 0) *body++ = ' ';
    emitted++;
    *body++ = '"';
    while (i < len) {
      if (ws_len(in, i, len)) break;
      const uint8_t c = in[i];
      if (c == '"') {
        *body++ = '"';
        *body++ = '"';
      } else {
        *body++ = c;
      }
      i += 1;
    }
    *body++ = '"';
  }
  return (uint32_t)(size_t)buf;
}
