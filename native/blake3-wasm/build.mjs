#!/usr/bin/env node
// Reproducible build entry — used by `npm run build:wasm` locally AND by
// the wasm-artifact CI job, so both produce byte-identical output.
//
// rustc embeds source paths (panic locations) of registry crates, which
// live under $CARGO_HOME — a machine-dependent absolute path. Remap both
// the registry root and the workspace to fixed virtual paths so the
// artifact is independent of who built it and where.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

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
execFileSync("node", [resolve(here, "embed.mjs")], { stdio: "inherit" });
