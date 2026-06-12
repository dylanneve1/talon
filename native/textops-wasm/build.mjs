#!/usr/bin/env node
// Build manifest for textops — Zig → wasm32-freestanding. `npm run
// build:zig` locally AND the zig-toolchain CI drift job both run this,
// so both produce byte-identical output.
//
// Zig sources go through `zig build-exe` (not the C driver in
// native/shared/build-lib.mjs), but share the same toolchain pin
// (native/.zig-version) and embed step. -fstrip keeps machine paths
// out of the artifact.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embedWasm, requirePinnedZig } from "../shared/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const zig = requirePinnedZig();

execFileSync(
  zig,
  [
    "build-exe",
    "src/textops.zig",
    "-target",
    "wasm32-freestanding",
    "-O",
    "ReleaseSmall",
    "-fno-entry",
    "-fstrip",
    "--export=alloc",
    "--export=dealloc",
    "--export=split_message",
    "-femit-bin=textops.wasm",
    // Keep compiler caches inside the crate dir (gitignored) so builds
    // never depend on or pollute machine-global state.
    "--cache-dir",
    ".zig-cache",
    "--global-cache-dir",
    ".zig-cache/global",
  ],
  { cwd: here, stdio: "inherit" },
);

embedWasm({
  wasmPath: join(here, "textops.wasm"),
  outFile: "textops-wasm-bytes.ts",
  constName: "TEXTOPS_WASM_BASE64",
  sourceDir: "native/textops-wasm",
  rebuildCmd: "npm run build:zig",
  consumer: "src/native/textops.ts",
});
