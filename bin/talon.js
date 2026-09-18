#!/usr/bin/env node
// Talon's runtime of record is Bun (docs/ts-migration-plan.md, Phase 1);
// Node 24 + tsx is the fallback. This shim is what `talon` resolves to
// from an npm install, so it is where the preference is decided: when the
// CLI was started by Node but a `bun` is on PATH, re-exec under Bun so the
// CLI — and the daemon `talon start` spawns from `process.execPath` — run
// on Bun. `TALON_RUNTIME=node` pins Node (CI, a broken Bun install, or a
// deliberate comparison run).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function bunOnPath() {
  const probe = spawnSync("bun", ["--version"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return probe.status === 0;
}

if (
  !process.versions.bun &&
  process.env.TALON_RUNTIME !== "node" &&
  bunOnPath()
) {
  const result = spawnSync(
    "bun",
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.error) {
    console.error(`Failed to start Talon under bun: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

(process.versions.bun ? Promise.resolve() : import("tsx"))
  .then(() => import("../src/cli.ts"))
  .catch((err) => {
    console.error("Failed to start Talon:", err.message);
    process.exit(1);
  });
