/**
 * Single source of truth for native plugin runtimes — the built-in
 * plugins whose MCP servers depend on an artifact Talon doesn't ship
 * (MemPalace's Python venv, Playwright's browser build, GitHub's Docker
 * image).
 *
 * Everything that iterates "the native plugins" — boot provisioning
 * (builtins.ts), doctor inspection (doctor.ts), the provisioning CI —
 * walks this list. Adding a native runtime is one descriptor here plus
 * its provision module; no other call site changes.
 *
 * Plugin modules load lazily inside each method so this module stays
 * import-cheap for consumers that only need the id list.
 */

import type { DoctorCheck } from "../doctor.js";
import type { ProvisionOutcome } from "./provision.js";
import type { MempalaceSection } from "../../plugins/mempalace/provision.js";
import type { PlaywrightSection } from "../../plugins/playwright/provision.js";
import type { GithubSection } from "../../plugins/github/provision.js";

const NATIVE_PLUGIN_IDS = ["mempalace", "playwright", "github"] as const;
export type NativePluginId = (typeof NATIVE_PLUGIN_IDS)[number];

/**
 * The config slice native runtimes read. Both TalonConfig and doctor's
 * DoctorConfigSlice satisfy it structurally.
 */
interface NativeRuntimeConfig {
  mempalace?: ({ enabled?: boolean } & MempalaceSection) | undefined;
  playwright?: ({ enabled?: boolean } & PlaywrightSection) | undefined;
  github?: ({ enabled?: boolean } & GithubSection) | undefined;
}

export interface NativeRuntime {
  id: NativePluginId;
  enabled(config: NativeRuntimeConfig | undefined): boolean;
  /** Install/heal/reconcile the runtime. Only called when enabled. */
  provision(config: NativeRuntimeConfig): Promise<ProvisionOutcome>;
  /** Read-only health report for doctor. Only called when enabled. */
  inspect(config: NativeRuntimeConfig): Promise<DoctorCheck[]>;
}

export const NATIVE_RUNTIMES: readonly NativeRuntime[] = [
  {
    id: "mempalace",
    enabled: (config) => config?.mempalace?.enabled === true,
    provision: async (config) => {
      const { provisionMempalace } =
        await import("../../plugins/mempalace/provision.js");
      return provisionMempalace(config.mempalace ?? {});
    },
    inspect: async (config) => {
      const { inspectMempalace } =
        await import("../../plugins/mempalace/provision.js");
      return inspectMempalace(config.mempalace ?? {});
    },
  },
  {
    id: "playwright",
    enabled: (config) => config?.playwright?.enabled === true,
    provision: async (config) => {
      const { provisionPlaywright } =
        await import("../../plugins/playwright/provision.js");
      return provisionPlaywright(config.playwright ?? {});
    },
    inspect: async (config) => {
      const { inspectPlaywright } =
        await import("../../plugins/playwright/provision.js");
      return inspectPlaywright(config.playwright ?? {});
    },
  },
  {
    id: "github",
    enabled: (config) => config?.github?.enabled === true,
    provision: async (config) => {
      const { provisionGithubMcp } =
        await import("../../plugins/github/provision.js");
      return provisionGithubMcp(config.github ?? {});
    },
    inspect: async (config) => {
      const { inspectGithub } =
        await import("../../plugins/github/provision.js");
      return inspectGithub(config.github ?? {});
    },
  },
];
