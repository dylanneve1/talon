import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _deps, reloadState } from "../core/plugin/registry.js";

/**
 * ESM caches modules by resolved URL for the process lifetime, so a hot
 * reload that re-imports the same path gets the *old* module back and the
 * plugin's edited source never takes effect until a full restart.
 */
describe("plugin module import cache", () => {
  it("re-evaluates a changed plugin file after the reload timestamp moves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-reload-"));
    const file = join(dir, "plugin.mjs");

    await writeFile(file, 'export default { name: "p", version: "1.0.0" };');
    const first = (await _deps.importModule(file)).default as {
      version: string;
    };
    expect(first.version).toBe("1.0.0");

    // The plugin's source changes on disk, then Talon hot-reloads.
    await writeFile(file, 'export default { name: "p", version: "2.0.0" };');
    reloadState.lastReloadAt = new Date(Date.now() + 1000).toISOString();

    const second = (await _deps.importModule(file)).default as {
      version: string;
    };
    expect(second.version).toBe("2.0.0");
  });

  it("returns the cached module within a single load cycle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "talon-reload-"));
    const file = join(dir, "plugin.mjs");

    await writeFile(file, 'export default { name: "p", version: "1.0.0" };');
    const a = await _deps.importModule(file);
    const b = await _deps.importModule(file);
    expect(a).toBe(b);
  });
});
