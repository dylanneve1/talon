#!/usr/bin/env node
// Build manifest for talon-warden — the Rust supervision harness
// compiled to a native per-arch binary (toolchain pinned by
// rust-toolchain.toml, same pin as blake3-wasm).
//
// Like talon-driver there is no embedded artifact of record: the warden
// is a real executable shipped by the native-binary channels (apt
// `.deb`, Homebrew bottle, source install), built per arch and never
// committed. npm installs run without it — triggers.ts falls back to
// the in-process TS supervision path when the binary is absent.
//
//   node build.mjs                        host build  -> bin/talon-warden
//   node build.mjs --target=<rust-triple> cross build -> native/talon-warden/dist/
//
// Cross builds need the rustup target installed (e.g.
// `rustup target add aarch64-unknown-linux-musl`). Unlike zig cc there
// is no built-in macOS cross-sysroot, so the release matrix builds each
// OS on its own runner.
//
// Uses only node builtins so it runs on the bare runner node in CI
// without an `npm ci`.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const cargoHome = process.env.CARGO_HOME || resolve(homedir(), ".cargo");

const argv = process.argv.slice(2);
const targetArg = argv.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.slice("--target=".length) : null;

const cargoArgs = ["build", "--release", "--locked"];
if (target) cargoArgs.push("--target", target);

execFileSync("cargo", cargoArgs, {
  cwd: here,
  stdio: "inherit",
  env: {
    ...process.env,
    // Strip machine-dependent absolute paths (panic locations) so the
    // binary is independent of who built it and where — same remap the
    // blake3-wasm build uses.
    RUSTFLAGS: `--remap-path-prefix=${cargoHome}=/cargo-home --remap-path-prefix=${here}=/build`,
  },
});

// Windows toolchains emit a .exe; the host build follows the runner's
// platform, a cross build follows the target triple.
const isWindows = target
  ? target.includes("windows")
  : process.platform === "win32";
const ext = isWindows ? ".exe" : "";

const built = target
  ? join(here, "target", target, "release", `talon-warden${ext}`)
  : join(here, "target", "release", `talon-warden${ext}`);

let outPath;
if (target) {
  const distDir = join(here, "dist");
  mkdirSync(distDir, { recursive: true });
  outPath = join(distDir, `talon-warden-${target}${ext}`);
} else {
  outPath = join(repoRoot, "bin", `talon-warden${ext}`);
}
copyFileSync(built, outPath);
console.log(`built ${outPath}${target ? ` (${target})` : " (host)"}`);
