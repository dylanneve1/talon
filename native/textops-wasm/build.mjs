#!/usr/bin/env node
// Reproducible build entry — used by `npm run build:zig` locally AND by
// the zig-artifact CI job, so both produce byte-identical output.
//
// Zig's output is deterministic for a fixed compiler version and flag
// set, and -fstrip keeps machine paths out of the artifact. The compiler
// version is pinned in .zig-version and enforced here so codegen drift
// between Zig releases can't break the CI drift diff.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pinned = readFileSync(resolve(here, ".zig-version"), "utf-8").trim();

const zig = process.env.ZIG || "zig";
const version = execFileSync(zig, ["version"], { encoding: "utf-8" }).trim();
if (version !== pinned) {
  console.error(
    `textops-wasm: zig ${version} found, but the artifact is pinned to ` +
      `${pinned} (.zig-version). Install the pinned toolchain from ` +
      `https://ziglang.org/download/ or point ZIG at it.`,
  );
  process.exit(1);
}

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
execFileSync("node", [resolve(here, "embed.mjs")], { stdio: "inherit" });
