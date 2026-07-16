/**
 * Plugin management over the live config — the shared list/toggle logic
 * behind the bridge's plugin endpoints (core/plugin/manage.ts).
 */

import { describe, expect, it } from "vitest";
import { listPluginItems, setPluginEnabled } from "../core/plugin/manage.js";
import type { TalonConfig } from "../util/config.js";
import type { PluginEntry } from "../core/plugin/types.js";

function fakeConfig(input: {
  plugins?: PluginEntry[];
  github?: { enabled?: boolean };
}): TalonConfig {
  return {
    plugins: input.plugins ?? [],
    ...(input.github ? { github: input.github } : {}),
  } as unknown as TalonConfig;
}

describe("listPluginItems", () => {
  it("lists built-ins first, then configured entries with kind and state", () => {
    const config = fakeConfig({
      github: { enabled: true },
      plugins: [
        { path: "/plugins/node_modules/@scope/pkg" },
        {
          name: "fetch",
          command: "npx",
          args: ["-y", "server-fetch"],
          enabled: false,
        },
      ],
    });

    const items = listPluginItems(config);
    expect(items[0]).toMatchObject({
      name: "github",
      kind: "builtin",
      enabled: true,
      source: "config.github",
    });
    // Built-ins without a section are listed disabled, not hidden.
    expect(items.find((i) => i.name === "mempalace")).toMatchObject({
      kind: "builtin",
      enabled: false,
    });
    expect(items.at(-2)).toMatchObject({
      name: "@scope/pkg",
      kind: "module",
      enabled: true,
    });
    expect(items.at(-1)).toMatchObject({
      name: "fetch",
      kind: "mcp",
      enabled: false,
      source: "npx -y server-fetch",
    });
  });
});

describe("setPluginEnabled", () => {
  it("toggles a built-in via its config section and reports the persist patch", () => {
    const config = fakeConfig({ github: { enabled: false } });

    const outcome = setPluginEnabled(config, "github", true);
    expect(outcome).toEqual({
      ok: true,
      name: "github",
      persist: { github: { enabled: true } },
    });
    // The LIVE config changed too — in-process readers see it immediately.
    expect(
      (config as unknown as { github: { enabled: boolean } }).github.enabled,
    ).toBe(true);
  });

  it("disables a configured entry by display name, enabling removes the key", () => {
    const config = fakeConfig({
      plugins: [{ path: "/plugins/node_modules/my-plugin" }],
    });

    const disabled = setPluginEnabled(config, "my-plugin", false);
    expect(disabled).toMatchObject({ ok: true, name: "my-plugin" });
    expect(config.plugins[0]).toMatchObject({ enabled: false });

    const enabled = setPluginEnabled(config, "my-plugin", true);
    expect(enabled.ok).toBe(true);
    expect("enabled" in config.plugins[0]!).toBe(false);
  });

  it("refuses unknown and empty names as data, not throws", () => {
    const config = fakeConfig({});
    expect(setPluginEnabled(config, "nope", true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("nope"),
    });
    expect(setPluginEnabled(config, "  ", true)).toMatchObject({ ok: false });
  });
});
