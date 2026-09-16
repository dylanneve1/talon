import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_TALON_HOME = process.env.TALON_HOME;

// paths.ts resolves TALON_HOME at import time, so each test points the env at
// a fresh tree and re-imports the module graph.
async function importPlaywrightFor(root: string) {
  process.env.TALON_HOME = root;
  vi.resetModules();
  const [{ createPlaywrightPlugin }, { files }] = await Promise.all([
    import("../plugins/playwright/index.js"),
    import("../util/paths.js"),
  ]);
  return { createPlaywrightPlugin, files };
}

afterEach(() => {
  if (ORIGINAL_TALON_HOME === undefined) delete process.env.TALON_HOME;
  else process.env.TALON_HOME = ORIGINAL_TALON_HOME;
  vi.resetModules();
});

describe("playwright plugin — endpoint mode MCP config", () => {
  it("writes the config under ~/.talon/data, not os.tmpdir()", async () => {
    const root = await mkdtemp(join(tmpdir(), "talon-pw-"));
    const { createPlaywrightPlugin, files } = await importPlaywrightFor(root);

    const plugin = createPlaywrightPlugin({
      browser: "firefox",
      endpoint: "ws://localhost:9323/camoufox",
    });

    expect(files.playwrightMcpConfig.startsWith(root)).toBe(true);
    expect(existsSync(files.playwrightMcpConfig)).toBe(true);
    expect(
      JSON.parse(readFileSync(files.playwrightMcpConfig, "utf-8")),
    ).toEqual({
      browser: {
        browserName: "firefox",
        remoteEndpoint: "ws://localhost:9323/camoufox",
      },
    });
    expect(plugin.mcpServer?.args).toContain(files.playwrightMcpConfig);
  });

  it("re-creates a deleted config on prepareMcpSpawn", async () => {
    const root = await mkdtemp(join(tmpdir(), "talon-pw-"));
    const { createPlaywrightPlugin, files } = await importPlaywrightFor(root);

    const plugin = createPlaywrightPlugin({
      browser: "firefox",
      endpoint: "ws://localhost:9323/camoufox",
    });

    // What an hourly /tmp sweeper (or any stray rm) did in production.
    rmSync(files.playwrightMcpConfig);
    expect(existsSync(files.playwrightMcpConfig)).toBe(false);

    plugin.prepareMcpSpawn?.();
    expect(existsSync(files.playwrightMcpConfig)).toBe(true);
  });

  it("writes no config when running a local browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "talon-pw-"));
    const { createPlaywrightPlugin, files } = await importPlaywrightFor(root);

    const plugin = createPlaywrightPlugin({ browser: "chromium" });

    expect(existsSync(files.playwrightMcpConfig)).toBe(false);
    plugin.prepareMcpSpawn?.();
    expect(existsSync(files.playwrightMcpConfig)).toBe(false);
    expect(plugin.mcpServer?.args).not.toContain("--config");
  });
});
