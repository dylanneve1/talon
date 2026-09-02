#!/usr/bin/env node
/**
 * Architecture gate — dependency-cruiser, with a floor on how much it saw.
 *
 * Running `depcruise src` on its own is not enough, and this script exists
 * because of how that failed in practice: the repo compiles with
 * typescript@7, whose API dependency-cruiser cannot drive, so
 * `.dependency-cruiser.cjs` selects swc as the parser instead. When
 * `@swc/core` is absent, dependency-cruiser does not fail — it parses almost
 * nothing and reports
 *
 *     ✔ no dependency violations found (3 modules, 2 dependencies cruised)
 *
 * out of ~590. A green tick on 0.5% of the codebase is indistinguishable
 * from a real pass in CI logs, so the boundary rules in
 * `.dependency-cruiser.cjs` were enforcing nothing at all while looking
 * healthy.
 *
 * So the gate asserts two things, not one:
 *   1. no `error`-severity violations (the ratified boundaries hold), and
 *   2. the cruise actually covered the codebase (MODULE_FLOOR).
 *
 * `warn`-severity violations are printed and do NOT fail: those are the
 * in-flight migrations documented in the config, each ratcheting to `error`
 * when its migration lands.
 *
 * MODULE_FLOOR is a ratchet in the same spirit as scripts/check-ratchets.mjs
 * — raise it when the tree grows; never lower it to make a red build green,
 * because a drop is the exact symptom this guards against.
 */

import { spawnSync } from "node:child_process";

/**
 * Fewest modules a healthy cruise may report. The tree cruises ~587 today;
 * the floor sits below that so ordinary file deletions don't trip it, and
 * far above the ~3 a parser-less cruise produces.
 */
const MODULE_FLOOR = 450;

const run = spawnSync(
  "npx",
  ["depcruise", "src", "--output-type", "json"],
  // A large tree easily exceeds the default pipe buffer; JSON truncated
  // mid-parse would look like a crash rather than a result.
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);

if (run.error) {
  console.error(`✖ could not run dependency-cruiser: ${run.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  // depcruise exits non-zero when it finds violations, so a parse failure —
  // not the exit code — is what tells us it never produced a report.
  console.error("✖ dependency-cruiser produced no parsable report");
  if (run.stderr.trim()) console.error(run.stderr.trim());
  process.exit(1);
}

const summary = report.summary ?? {};
const modules = summary.totalCruised ?? 0;
const violations = summary.violations ?? [];
const errors = violations.filter((v) => v.rule.severity === "error");
const warnings = violations.filter((v) => v.rule.severity === "warn");

let failed = false;

if (modules < MODULE_FLOOR) {
  failed = true;
  console.error(
    `✖ architecture gate saw only ${modules} modules (floor ${MODULE_FLOOR}) — ` +
      "the cruise is blind, not clean.",
  );
  console.error(
    "  Almost always a missing parser: `.dependency-cruiser.cjs` selects swc " +
      "(typescript@7 can't drive dependency-cruiser), so @swc/core must be " +
      "installed. Check `npm ls @swc/core`.",
  );
}

for (const violation of errors) {
  console.error(
    `✖ ${violation.rule.name}: ${violation.from} → ${violation.to}`,
  );
}
if (errors.length > 0) failed = true;

if (warnings.length > 0) {
  const byRule = new Map();
  for (const violation of warnings) {
    byRule.set(violation.rule.name, (byRule.get(violation.rule.name) ?? 0) + 1);
  }
  const listed = [...byRule]
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
  console.log(`→ ${warnings.length} in-flight migration warnings: ${listed}`);
}

if (!failed) {
  console.log(
    `✔ architecture gate: ${modules} modules, ` +
      `${summary.totalDependenciesCruised ?? 0} dependencies, 0 errors`,
  );
}

process.exit(failed ? 1 : 0);
