#!/usr/bin/env node
// Build manifest for blake3 — Rust → wasm32-unknown-unknown. `npm run
// build:wasm` locally AND the wasm-artifact CI job both run this, so
// both produce byte-identical output.
//
// rustc embeds source paths (panic locations) of registry crates, which
// live under $CARGO_HOME — a machine-dependent absolute path. Remap both
// the registry root and the workspace to fixed virtual paths so the
// artifact is independent of who built it and where. The embed step is
// shared with the rest of the native plane (native/shared/build-lib.mjs).
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { embedWasm } from "../shared/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cargoHome = process.env.CARGO_HOME || resolve(homedir(), ".cargo");

execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "--locked"],
  {
    cwd: here,
    stdio: "inherit",
    env: {
      ...process.env,
      RUSTFLAGS: `--remap-path-prefix=${cargoHome}=/cargo-home --remap-path-prefix=${here}=/build`,
    },
  },
);

embedWasm({
  wasmPath: join(
    here,
    "target",
    "wasm32-unknown-unknown",
    "release",
    "blake3_wasm.wasm",
  ),
  outFile: "blake3-wasm-bytes.ts",
  constName: "BLAKE3_WASM_BASE64",
  sourceDir: "native/blake3-wasm",
  rebuildCmd: "npm run build:wasm",
  consumer: "src/native/blake3.ts",
  target: "wasm32-unknown-unknown",
});
