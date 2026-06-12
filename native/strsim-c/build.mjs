#!/usr/bin/env node
// Build manifest for strsim — C → wasm32-freestanding via the shared
// driver (native/shared/build-lib.mjs). `npm run build:c` locally AND
// the zig-toolchain CI drift job both run this, so both produce
// byte-identical output.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWasm, embedWasm } from "../shared/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

compileWasm({
  moduleDir: here,
  language: "c",
  sources: ["src/strsim.c"],
  outName: "strsim.wasm",
});

embedWasm({
  wasmPath: join(here, "strsim.wasm"),
  outFile: "strsim-wasm-bytes.ts",
  constName: "STRSIM_WASM_BASE64",
  sourceDir: "native/strsim-c",
  rebuildCmd: "npm run build:c",
  consumer: "src/native/strsim.ts",
});
