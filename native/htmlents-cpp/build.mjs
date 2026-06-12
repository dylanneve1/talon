#!/usr/bin/env node
// Build manifest for htmlents — C++ → wasm32-freestanding via the
// shared driver (native/shared/build-lib.mjs). `npm run build:cpp`
// locally AND the zig-toolchain CI drift job both run this, so both
// produce byte-identical output.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileWasm, embedWasm } from "../shared/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

compileWasm({
  moduleDir: here,
  language: "c++",
  sources: ["src/htmlents.cpp"],
  outName: "htmlents.wasm",
});

embedWasm({
  wasmPath: join(here, "htmlents.wasm"),
  outFile: "htmlents-wasm-bytes.ts",
  constName: "HTMLENTS_WASM_BASE64",
  sourceDir: "native/htmlents-cpp",
  rebuildCmd: "npm run build:cpp",
  consumer: "src/native/htmlents.ts",
});
