/*
 * strsim — string-similarity core in C, compiled to wasm32-freestanding.
 *
 * Powers "did you mean ...?" suggestions for unknown Telegram slash
 * commands and unknown CLI subcommands. The TypeScript consumer is
 * src/native/strsim.ts; the ABI is alloc / dealloc (native/shared/
 * walloc.h) plus `levenshtein` over linear memory — see README.md for
 * the contract.
 *
 * Distance is computed over bytes. Inputs are UTF-8, and for the ASCII
 * identifiers this module exists for (command names, subcommands,
 * model ids) byte distance equals character distance. Non-ASCII text
 * weighs a substituted codepoint as up to 4 edits — acceptable for
 * ranking, documented at the wrapper.
 *
 * The DP uses one statically-allocated row (two-row trick folded into
 * one row + a diagonal carry), so `levenshtein` itself never touches
 * the allocator. Strings longer than STRSIM_MAX_LEN return the
 * STRSIM_OVERFLOW sentinel instead of a distance — the wrapper maps
 * that to "no match" / a thrown error.
 */

#include <stddef.h>
#include <stdint.h>

#include "../../shared/walloc.h"

#define STRSIM_MAX_LEN 1024u
#define STRSIM_OVERFLOW 0xFFFFFFFFu

static uint32_t row[STRSIM_MAX_LEN + 1u];

__attribute__((export_name("levenshtein"))) uint32_t levenshtein(
    const uint8_t *a, size_t a_len, const uint8_t *b, size_t b_len) {
  if (a_len > STRSIM_MAX_LEN || b_len > STRSIM_MAX_LEN) {
    return STRSIM_OVERFLOW;
  }
  if (a_len == 0) return (uint32_t)b_len;
  if (b_len == 0) return (uint32_t)a_len;

  for (size_t j = 0; j <= b_len; j++) {
    row[j] = (uint32_t)j;
  }
  for (size_t i = 1; i <= a_len; i++) {
    uint32_t diag = row[0]; /* D(i-1, j-1) */
    row[0] = (uint32_t)i;
    for (size_t j = 1; j <= b_len; j++) {
      uint32_t above = row[j]; /* D(i-1, j) */
      uint32_t best = diag + (a[i - 1u] == b[j - 1u] ? 0u : 1u);
      uint32_t del = above + 1u;
      uint32_t ins = row[j - 1u] + 1u;
      if (del < best) best = del;
      if (ins < best) best = ins;
      row[j] = best;
      diag = above;
    }
  }
  return row[b_len];
}
