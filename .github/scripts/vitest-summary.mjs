import { existsSync, readFileSync, appendFileSync } from "node:fs";

const [resultPath, title, coveragePath] = process.argv.slice(2);
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

if (!summaryPath || !resultPath || !existsSync(resultPath)) {
  process.exit(0);
}

const result = JSON.parse(readFileSync(resultPath, "utf8"));
const durationMs =
  result.testResults?.reduce(
    (sum, suite) => sum + Math.max(0, suite.endTime - suite.startTime),
    0,
  ) ?? 0;

const lines = [
  `### ${title ?? "Vitest Results"}`,
  "",
  "| Metric | Value |",
  "|--------|-------|",
  `| Suites | ${result.numTotalTestSuites ?? 0} |`,
  `| Passed | ${result.numPassedTests ?? 0} |`,
  `| Failed | ${result.numFailedTests ?? 0} |`,
  `| Total | ${result.numTotalTests ?? 0} |`,
  `| Duration | ${(durationMs / 1000).toFixed(1)}s |`,
  "",
];

if (coveragePath && existsSync(coveragePath)) {
  const coverage = JSON.parse(readFileSync(coveragePath, "utf8")).total;
  lines.push("### Coverage Report", "");
  lines.push("| Category | Coverage |", "|----------|----------|");
  for (const [key, value] of Object.entries(coverage)) {
    lines.push(
      `| ${key.charAt(0).toUpperCase()}${key.slice(1)} | ${value.pct}% |`,
    );
  }
  lines.push("");
}

appendFileSync(summaryPath, `${lines.join("\n")}\n`);
