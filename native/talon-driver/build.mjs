#!/usr/bin/env node
// Build manifest for talon-driver — the C launcher compiled to a native
// per-arch binary via `zig cc` (pinned toolchain, native/.zig-version),
// the same driver the rest of the native plane builds through.
//
// Unlike the wasm modules there is no embedded artifact of record: the
// launcher is a real executable shipped by the native-binary channels
// (apt `.deb`, Homebrew bottle, source install), built per arch and not
// committed. So this script just compiles — there is nothing to embed
// or drift-check.
//
//   node build.mjs                       host build  -> bin/talon
//   node build.mjs --target=<zig-target> cross build -> native/talon-driver/dist/
//   node build.mjs --all                 the full distribution matrix
//
// Uses only node builtins so it runs on the bare runner node in CI
// without an `npm ci`.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requirePinnedZig } from "../shared/build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const zig = requirePinnedZig();

// The distribution matrix. Linux uses musl so `zig cc` emits a static
// binary with no libc dependency — one file that runs across distros in
// a `.deb`. macOS links the system libSystem as usual.
const TARGETS = [
  "x86_64-linux-musl",
  "aarch64-linux-musl",
  "x86_64-macos",
  "aarch64-macos",
];

// -g0: no debug info in the shipped launcher (smaller, cleaner artifact).
const COMMON_FLAGS = ["-O2", "-g0", "-std=c11", "-Wall", "-Wextra", "-Werror"];

/** Compile for `target` (null = host) and return the output path. */
function build(target) {
  const args = ["cc", ...COMMON_FLAGS];
  if (target) args.push("-target", target);

  let outPath;
  if (target) {
    const distDir = join(here, "dist");
    mkdirSync(distDir, { recursive: true });
    outPath = join(distDir, `talon-${target}`);
  } else {
    outPath = join(repoRoot, "bin", "talon");
  }

  args.push("src/main.c", "-o", outPath);
  execFileSync(zig, args, {
    cwd: here,
    stdio: "inherit",
    // Keep the zig cc cache inside the module dir (gitignored) so builds
    // never depend on or pollute machine-global state.
    env: {
      ...process.env,
      ZIG_LOCAL_CACHE_DIR: join(here, ".zig-cache"),
      ZIG_GLOBAL_CACHE_DIR: join(here, ".zig-cache", "global"),
    },
  });
  console.log(`built ${outPath}${target ? ` (${target})` : " (host)"}`);
  return outPath;
}

const argv = process.argv.slice(2);
if (argv.includes("--all")) {
  for (const target of TARGETS) build(target);
} else {
  const targetArg = argv.find((a) => a.startsWith("--target="));
  build(targetArg ? targetArg.slice("--target=".length) : null);
}
