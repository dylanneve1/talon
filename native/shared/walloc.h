/*
 * walloc.h — shared linear-memory allocator for Talon's freestanding
 * wasm modules (C strsim, C++ htmlents).
 *
 * Implements the `alloc` / `dealloc` half of the native-plane ABI
 * (see src/native/runtime.ts): alloc(0) == 0, alloc returns 0 on
 * exhaustion, dealloc(0, *) and dealloc(*, 0) are no-ops.
 *
 * Design: a bump allocator over [__heap_base, memory end) with a live
 * counter. The JS wrappers make fully balanced alloc/dealloc pairs
 * within one synchronous call — nothing survives across calls — so
 * when the last live region is released the bump pointer rewinds to
 * the heap base in one step. O(1) alloc, O(1) dealloc, zero metadata.
 *
 * NOT suitable for modules that hold allocations across calls
 * (streaming handles etc.) — those need a real allocator, like the
 * Rust one in native/blake3-wasm.
 *
 * Single-translation-unit modules only: this header defines the
 * functions (each module is one .c/.cpp file, so there is exactly one
 * definition per artifact).
 */
#ifndef TALON_WALLOC_H
#define TALON_WALLOC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* First byte past static data + shadow stack, provided by wasm-ld. */
extern unsigned char __heap_base;

#define WALLOC_PAGE_BYTES 65536u
#define WALLOC_ALIGN 8u

static size_t walloc_top = 0; /* next free offset; 0 = not yet initialized */
static uint32_t walloc_live = 0; /* live allocation count */

__attribute__((export_name("alloc"))) void *walloc_alloc(size_t len) {
  if (len == 0) return 0;
  if (walloc_top == 0) walloc_top = (size_t)&__heap_base;
  walloc_top = (walloc_top + (WALLOC_ALIGN - 1u)) & ~(size_t)(WALLOC_ALIGN - 1u);
  size_t ptr = walloc_top;
  size_t end = ptr + len;
  if (end < ptr) return 0; /* address-space overflow */
  size_t have = (size_t)__builtin_wasm_memory_size(0) * WALLOC_PAGE_BYTES;
  if (end > have) {
    size_t need = (end - have + WALLOC_PAGE_BYTES - 1u) / WALLOC_PAGE_BYTES;
    if (__builtin_wasm_memory_grow(0, need) == (size_t)-1) return 0;
  }
  walloc_top = end;
  walloc_live += 1u;
  return (void *)ptr;
}

__attribute__((export_name("dealloc"))) void walloc_dealloc(void *ptr,
                                                            size_t len) {
  if (ptr == 0 || len == 0) return;
  if (walloc_live > 0u && --walloc_live == 0u) {
    walloc_top = (size_t)&__heap_base;
  }
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* TALON_WALLOC_H */
