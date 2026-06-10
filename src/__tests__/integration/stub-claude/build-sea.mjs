#!/usr/bin/env node
/**
 * Build a Single Executable Application (SEA) wrapping `fake-claude.mjs`.
 *
 * Why we need this: on Windows, Node 20.19+ refuses to spawn `.cmd` / `.bat`
 * shims via `child_process.spawn` without `shell: true` (CVE-2024-27980).
 * The Claude Agent SDK calls `spawn(claudeBinary, args)` directly, so a
 * `.cmd` wrapper around our `.mjs` stub is unspawnable. SEA produces a
 * native `.exe` (or platform-equivalent binary) that the SDK can spawn.
 *
 * Steps:
 *   1. Bundle `fake-claude.mjs` (ESM) → `fake-claude.cjs` (CJS) with esbuild,
 *      because Node SEA loads main as CommonJS by default.
 *   2. Generate the SEA preparation blob:
 *        node --experimental-sea-config sea-config.json
 *   3. Copy the running `node` binary to `fake-claude(.exe)`.
 *   4. Inject the blob with postject (Sentinel: `NODE_SEA_FUSE_…`).
 *
 * The build is idempotent — safe to re-run. Output binary lives next to
 * the source files in `stub-claude/`.
 *
 * Usage:
 *   node build-sea.mjs        # builds for the current platform
 *   npm run build:stub-sea    # same, via the npm script
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_SRC = resolve(__dirname, "fake-claude.mjs");
const BUNDLE_DEST = resolve(__dirname, "fake-claude.cjs");
const BLOB_PATH = resolve(__dirname, "sea-prep.blob");
const EXE_NAME =
  process.platform === "win32" ? "fake-claude.exe" : "fake-claude";
const EXE_PATH = resolve(__dirname, EXE_NAME);
const SEA_CONFIG = resolve(__dirname, "sea-config.json");
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function step(label) {
  process.stdout.write(`\n[build-sea] ${label}\n`);
}

function run(label, cmd, args, opts = {}) {
  step(label);
  const useShell = opts.shell ?? process.platform === "win32";
  // With shell:true, cmd.exe word-splits an unquoted command path —
  // `C:\Program Files\nodejs\node.exe` breaks at the space.
  const shellSafeCmd = useShell && cmd.includes(" ") ? `"${cmd}"` : cmd;
  const result = spawnSync(shellSafeCmd, args, {
    stdio: "inherit",
    cwd: __dirname,
    shell: useShell,
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status})`);
  }
}

// ── 1. Bundle ESM → CJS ────────────────────────────────────────────────────
const esbuildBin = resolve(
  __dirname,
  "../../../../node_modules/.bin/esbuild" +
    (process.platform === "win32" ? ".cmd" : ""),
);
if (!existsSync(esbuildBin)) {
  throw new Error(
    `esbuild not found at ${esbuildBin}. Run \`npm install\` first.`,
  );
}
run("Bundling fake-claude.mjs → fake-claude.cjs", esbuildBin, [
  BUNDLE_SRC,
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${BUNDLE_DEST}`,
]);

// ── 2. Generate SEA blob ───────────────────────────────────────────────────
run("Generating SEA preparation blob", process.execPath, [
  "--experimental-sea-config",
  SEA_CONFIG,
]);

if (!existsSync(BLOB_PATH)) {
  throw new Error(`Expected blob at ${BLOB_PATH} but it doesn't exist`);
}

// ── 3. Copy node binary ────────────────────────────────────────────────────
step(`Copying ${process.execPath} → ${EXE_PATH}`);
copyFileSync(process.execPath, EXE_PATH);
if (process.platform !== "win32") {
  chmodSync(EXE_PATH, 0o755);
}

// ── 4. Inject blob via postject ────────────────────────────────────────────
const postjectArgs = [
  "postject",
  EXE_PATH,
  "NODE_SEA_BLOB",
  BLOB_PATH,
  "--sentinel-fuse",
  SENTINEL_FUSE,
];
if (process.platform === "darwin") {
  // macOS requires the mach-o segment name to be specified.
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}
run("Injecting SEA blob with postject", "npx", ["--yes", ...postjectArgs]);

// ── Summary ────────────────────────────────────────────────────────────────
const finalSize = statSync(EXE_PATH).size;
step(
  `Done. ${EXE_NAME} (${(finalSize / 1024 / 1024).toFixed(1)} MB) ready at ${EXE_PATH}`,
);
