#!/usr/bin/env node
// Build manifest for sqlguard — C → wasm32-freestanding via the shared
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
  sources: ["src/sqlguard.c"],
  outName: "sqlguard.wasm",
});

embedWasm({
  wasmPath: join(here, "sqlguard.wasm"),
  outFile: "sqlguard-wasm-bytes.ts",
  constName: "SQLGUARD_WASM_BASE64",
  sourceDir: "native/sqlguard-c",
  rebuildCmd: "npm run build:c",
  consumer: "src/native/sqlguard.ts",
});
