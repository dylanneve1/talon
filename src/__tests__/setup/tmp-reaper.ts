/**
 * Global test teardown — reap leaked `mkdtemp` scratch directories.
 *
 * Most suites tear down their own temp dirs, but a dozen or so create one in
 * `beforeAll` and never remove it (native-tools, native-frontend, mesh-service,
 * the soul-* suites, node-binaries, native-tls, harden, protocol-conformance …).
 * Each full `vitest run` therefore leaves a fresh pile behind in `os.tmpdir()`,
 * and `native-tools.test.ts` alone writes ~33 MB of fixtures (`big.log`,
 * `blob.bin`) per run. On a dev box that runs the suite repeatedly this is a
 * real disk leak — it filled several GB of root in a single afternoon.
 *
 * Rather than patch (and keep re-patching) every suite, reap centrally:
 *   - snapshot `os.tmpdir()` before the run,
 *   - after the run delete directories that appeared *during* it and whose
 *     name matches a prefix the test suite owns.
 *
 * Both conditions must hold, so a temp dir belonging to a concurrently running
 * daemon — or anything predating the run — is never touched. Set
 * `TALON_TEST_KEEP_TMP=1` to disable reaping when debugging a suite's fixtures.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Prefixes owned by this repo's suites (see `mkdtemp` calls in src/__tests__). */
const OWNED = /^(talon|soul|blake3-napi-test|blake3-wasm|trigger-log-err)-/;

async function listTmp(): Promise<Set<string>> {
  try {
    return new Set(await readdir(tmpdir()));
  } catch {
    return new Set();
  }
}

export async function setup(): Promise<() => Promise<void>> {
  if (process.env.TALON_TEST_KEEP_TMP === "1") {
    return async () => {};
  }

  const root = tmpdir();
  const before = await listTmp();

  return async () => {
    const after = await listTmp();
    for (const name of after) {
      if (before.has(name) || !OWNED.test(name)) continue;
      const path = join(root, name);
      try {
        if (!(await stat(path)).isDirectory()) continue;
        await rm(path, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup: a racing suite or a permission quirk must never
        // fail the run.
      }
    }
  };
}
