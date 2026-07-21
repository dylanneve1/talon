#!/usr/bin/env node
// Build manifest for strsim — Rust → wasm32-unknown-unknown via the
// shared cargo driver (native/shared/build-lib.mjs). `npm run
// build:wasm` locally AND the wasm-artifact CI job both run this, so
// both produce byte-identical output.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoBuildWasm, embedWasm } from "../shared/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const wasmPath = cargoBuildWasm({ moduleDir: here, crateName: "strsim_wasm" });

embedWasm({
  wasmPath,
  outFile: "strsim-wasm-bytes.ts",
  constName: "STRSIM_WASM_BASE64",
  sourceDir: "native/strsim-wasm",
  rebuildCmd: "npm run build:wasm",
  consumer: "src/native/strsim.ts",
  target: "wasm32-unknown-unknown",
});
