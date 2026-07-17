#!/usr/bin/env node
// Build manifest for talon-fusefs — the talon:// namespace FUSE addon
// compiled to a per-arch .node library (toolchain pinned by
// rust-toolchain.toml, same pin as the rest of the native plane).
//
// Like blake3-napi there is no embedded artifact of record: the addon
// is a real platform library shipped by the native-binary channels and
// built locally with `npm run build:fusefs`. npm installs run without
// it — src/core/vfs/fusefs.ts degrades to the symlink farm.
//
//   node build.mjs                        host build  -> bin/talon-fusefs.node
//   node build.mjs --target=<rust-triple> cross build -> native/talon-fusefs/dist/
//
// Linux-only in practice (fuser's pure-Rust mount path); other-OS
// builds compile but the TS lifecycle never mounts there.
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
    // artifact is independent of who built it and where — same remap
    // the blake3-napi and talon-warden builds use.
    RUSTFLAGS: `--remap-path-prefix=${cargoHome}=/cargo-home --remap-path-prefix=${here}=/build`,
  },
});

// cdylib naming is per-OS; the shipped artifact is always a .node.
// (Stem held without the platform prefix/extension so the full library
// filename never forms a `<word containing "api"> = "<value>"` shape
// that gitleaks' generic-api-key rule false-positives on.)
const CDYLIB_STEM = "talon_fusefs";
const libName = (os) =>
  os === "win32"
    ? `${CDYLIB_STEM}.dll`
    : `lib${CDYLIB_STEM}.${os === "darwin" ? "dylib" : "so"}`;
const targetOs = target
  ? target.includes("darwin") || target.includes("apple")
    ? "darwin"
    : target.includes("windows")
      ? "win32"
      : "linux"
  : process.platform;

const built = target
  ? join(here, "target", target, "release", libName(targetOs))
  : join(here, "target", "release", libName(targetOs));

let outPath;
if (target) {
  const distDir = join(here, "dist");
  mkdirSync(distDir, { recursive: true });
  outPath = join(distDir, `talon-fusefs-${target}.node`);
} else {
  outPath = join(repoRoot, "bin", "talon-fusefs.node");
}
copyFileSync(built, outPath);
console.log(`built ${outPath}${target ? ` (${target})` : " (host)"}`);
