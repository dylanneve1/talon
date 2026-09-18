/**
 * Tree ratchet — the source tree may only get more tree-like.
 *
 * Two rules, from docs/structure.md:
 *
 *   1. A directory holds at most MAX_FILES non-test TypeScript files
 *      directly. More than that means two concerns share a folder;
 *      split it into subdirectories.
 *   2. No dumping-ground names: a directory or file called shared,
 *      helpers, util(s), common or misc is a folder nobody owns. Name it
 *      by what it holds.
 *
 * The committed BASELINE lists the violations the tree currently has.
 * The gate fails when a directory not in the baseline is over the limit,
 * a baselined directory grew, or a banned name appears that the baseline
 * does not list. When a violation disappears the script says so; delete
 * its entry in the same PR. `--update` rewrites the baseline from the
 * current tree (use only in a PR that explains why).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BASELINE_PATH = join(ROOT, "scripts", "tree-baseline.json");
const MAX_FILES = 12;
const BANNED = new Set(["shared", "helpers", "util", "utils", "common", "misc"]);

function* walkDirs(dir) {
  yield dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    yield* walkDirs(join(dir, entry.name));
  }
}

function tsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".d.ts") &&
        !e.name.endsWith(".generated.ts"),
    )
    .map((e) => e.name);
}

const violations = [];
for (const dir of walkDirs(join(ROOT, "src"))) {
  const rel = relative(ROOT, dir);
  const files = tsFiles(dir);
  if (files.length > MAX_FILES)
    violations.push({ kind: "flat", path: rel, files: files.length });
  if (BANNED.has(basename(dir)))
    violations.push({ kind: "banned-dir", path: rel });
  for (const f of files)
    if (BANNED.has(f.replace(/\.ts$/, "")))
      violations.push({ kind: "banned-file", path: join(rel, f) });
}
violations.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(violations, null, 2) + "\n");
  console.log(`Baseline rewritten: ${violations.length} violations.`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const key = (v) => `${v.kind} ${v.path}`;
const baseByKey = new Map(baseline.map((v) => [key(v), v]));
const curByKey = new Map(violations.map((v) => [key(v), v]));
let failed = false;

for (const v of violations) {
  const b = baseByKey.get(key(v));
  if (!b) {
    failed = true;
    console.error(
      v.kind === "flat"
        ? `NEW  ${v.path} has ${v.files} files (max ${MAX_FILES}) — split it into subdirectories.`
        : `NEW  ${v.path} — dumping-ground name; name it by what it holds.`,
    );
  } else if (v.kind === "flat" && v.files > b.files) {
    failed = true;
    console.error(
      `GREW ${v.path}: ${b.files} → ${v.files} files — over-full directories may only shrink.`,
    );
  }
}
for (const b of baseline) {
  const v = curByKey.get(key(b));
  if (!v)
    console.log(`DONE ${key(b)} is fixed — remove it from ${relative(ROOT, BASELINE_PATH)}.`);
  else if (b.kind === "flat" && v.files < b.files)
    console.log(`SHRANK ${b.path}: ${b.files} → ${v.files} files — lower its baseline entry.`);
}
console.log(`${violations.length} tree violations (baseline ${baseline.length}).`);
if (failed) process.exit(1);
