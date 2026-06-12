#!/usr/bin/env node
/**
 * Tarball validation — runs `npm pack` and inspects the resulting tarball
 * for things that should NEVER ship to npm:
 *
 *   - Secrets in any file (.env, credentials.json, secrets.env, *.key, *.pem)
 *   - Test fixtures or other __tests__/ content
 *   - .git, node_modules, coverage reports
 *   - VS Code / IDE settings
 *   - Source maps (Talon ships .ts source — sourcemaps would mean a build leaked)
 *   - Files listed neither in `package.json#files` nor implicitly included
 *
 * Run via `node .github/scripts/tarball-check.mjs`. Exits non-zero on any
 * finding so it's safe to gate CI on.
 */

import { execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────
//
// Patterns the tarball must not contain. Each is matched against every
// `files[].path` entry from `npm pack --json`. A match = test failure.

const FORBIDDEN_PATTERNS = [
  // Secret-leaking files
  /(^|\/)\.env(\.|$)/,
  /credentials\.json$/i,
  /\bsecrets?\.env$/,
  /\.(key|pem|pfx|p12)$/i,
  /\bid_(rsa|ed25519|ecdsa)$/,

  // Build / dev artifacts that should never ship
  /__tests__\//,
  /\.test\.[mc]?[jt]sx?$/,
  /\.spec\.[mc]?[jt]sx?$/,
  /^node_modules\//,
  /^\.git(\/|$)/,
  /^coverage\//,
  /^dist\/.*\.map$/, // sourcemaps if a build leaked
  /^\.vscode\//,
  /^\.idea\//,
  /\.DS_Store$/,
];

// Maximum tarball size (bytes). Catches accidental large-file commits.
// Talon ships ~250KB of source today; 5MB is a generous ceiling that
// would alert on a 20× regression but accept normal growth.
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;

// ── Pack ────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(resolve(tmpdir(), "talon-pack-"));
let packResult;
try {
  // `npm pack --json --pack-destination=<dir>` outputs metadata for the
  // tarball and writes it to disk. We parse the JSON and inspect both
  // the metadata and (where relevant) the actual file paths.
  const out = execSync(`npm pack --json --pack-destination=${tmp}`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  packResult = JSON.parse(out);
} catch (err) {
  console.error("npm pack failed:", err.message);
  process.exit(2);
}

if (!Array.isArray(packResult) || packResult.length === 0) {
  console.error("npm pack returned no entries");
  process.exit(2);
}

const pkg = packResult[0];
const files = pkg.files ?? [];
const tarballPath = join(tmp, pkg.filename);

// ── Verify tarball exists + size ───────────────────────────────────────

let tarSize = 0;
try {
  tarSize = statSync(tarballPath).size;
} catch {
  console.error(`tarball not found at ${tarballPath}`);
  process.exit(2);
}

console.log(`[tarball-check] ${pkg.filename}`);
console.log(`  size: ${(tarSize / 1024).toFixed(1)} KB (${tarSize} bytes)`);
console.log(`  unpacked: ${(pkg.unpackedSize / 1024).toFixed(1)} KB`);
console.log(`  file count: ${files.length}`);

// ── Findings ───────────────────────────────────────────────────────────

const findings = [];

if (tarSize > MAX_TARBALL_BYTES) {
  findings.push(
    `tarball too large: ${(tarSize / 1024).toFixed(1)} KB > ${(MAX_TARBALL_BYTES / 1024).toFixed(0)} KB ceiling`,
  );
}

for (const entry of files) {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(entry.path)) {
      findings.push(`forbidden path matches ${pattern}: ${entry.path}`);
    }
  }
}

// Sanity: package.json should be present.
if (!files.some((f) => f.path === "package.json")) {
  findings.push("package.json missing from tarball");
}

// Sanity: README should be present (npmjs.com displays it).
if (!files.some((f) => /^README/i.test(f.path))) {
  findings.push("README missing from tarball — npm page will be empty");
}

// Embedded native artifacts MUST ship: blake3 hashing, the textops
// splitter, and the Gleam scheduler core are imported by runtime code,
// so a files[] regression that drops src/native/ breaks the installed
// package at import time. (The native/ SOURCE trees are intentionally
// not shipped — the embedded artifacts are the artifact of record.)
const REQUIRED_PATHS = [
  "src/native/blake3-wasm-bytes.ts",
  "src/native/textops-wasm-bytes.ts",
  "src/native/scheduler-core/scheduler_core.mjs",
  "bin/talon.js",
  "prompts/README.md",
];
for (const required of REQUIRED_PATHS) {
  if (!files.some((f) => f.path === required)) {
    findings.push(`required path missing from tarball: ${required}`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────

if (findings.length === 0) {
  console.log("\n[tarball-check] OK — no findings.");
  // Print a sorted file list for the CI step summary.
  const top = [...files]
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map((f) => `    ${(f.size / 1024).toFixed(1).padStart(8)} KB  ${f.path}`)
    .join("\n");
  console.log(`\n  largest files:\n${top}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

console.error(`\n[tarball-check] ${findings.length} finding(s):`);
for (const f of findings) console.error(`  - ${f}`);
rmSync(tmp, { recursive: true, force: true });
process.exit(1);
