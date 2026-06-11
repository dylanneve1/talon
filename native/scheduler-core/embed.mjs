#!/usr/bin/env node
// Copies the compiled Gleam JS artifacts into src/ — the committed
// artifacts of record (CI rebuilds and diffs to prevent drift).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../src/native/scheduler-core");
mkdirSync(out, { recursive: true });
for (const f of ["gleam.mjs", "gleam.d.mts", "scheduler_core.mjs", "scheduler_core.d.mts"]) {
  copyFileSync(resolve(here, "build/dev/javascript/scheduler_core", f), resolve(out, f));
}
// The gleam.mjs shim re-exports ../prelude.mjs — keep that layout.
for (const f of ["prelude.mjs", "prelude.d.mts"]) {
  copyFileSync(resolve(here, "build/dev/javascript", f), resolve(out, "..", f));
}
console.log("scheduler-core artifacts embedded");
