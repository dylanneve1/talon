/**
 * Playwright provisioner — browser builds present before first use.
 *
 * @playwright/mcp launches its browser lazily, so a missing build used
 * to surface as a mid-conversation tool error. This makes it a boot
 * concern instead: when the configured engine's build is absent from
 * the Playwright cache, run the bundled playwright-core CLI's `install`
 * (idempotent, version-matched to the pinned @playwright/mcp — the cli
 * resolves from the same dependency tree the MCP server runs).
 *
 * Deliberately out of scope, in line with never mutating what Talon
 * doesn't own: system channels (chrome, msedge) — those belong to the
 * OS; endpoint mode — the browser lives on the remote end.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DoctorCheck } from "../../core/doctor.js";
import {
  failDetail,
  loadProvisionState,
  markProvisionFailure,
  markProvisionSuccess,
  runStep,
  shouldAttempt,
  type ExecFn,
  type ProvisionOutcome,
} from "../../core/plugin/provision.js";
import { dirs } from "../../util/paths.js";

/** Engines whose builds Playwright manages (vs system channels). */
const MANAGED_ENGINES = new Set(["chromium", "firefox", "webkit"]);

const INSTALL_TIMEOUT_MS = 600_000;

/** The `playwright` config section this module reads. */
export interface PlaywrightSection {
  browser?: string;
  endpoint?: string;
  endpointFile?: string;
  autoProvision?: boolean;
}

export interface PlaywrightProvisionDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  statePath?: string;
  cliPath?: string;
  pathExists?: (p: string) => boolean;
  listDir?: (p: string) => string[];
}

/**
 * Where Playwright keeps downloaded builds, per OS — the same defaults
 * playwright-core's registry uses, and the same override env var.
 */
export function browsersRoot(
  platform: NodeJS.Platform,
  home: string,
  env: Record<string, string | undefined>,
): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== "0") return override;
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "ms-playwright");
  }
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
      "ms-playwright",
    );
  }
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

/** The bundled playwright-core CLI (version-matched to @playwright/mcp). */
function defaultCliPath(): string {
  return resolve(
    import.meta.dirname ?? ".",
    "../../../node_modules/playwright-core/cli.js",
  );
}

const safeListDir = (p: string): string[] => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/**
 * The engine build's presence is a directory-name check, not a
 * subprocess: any build dir for the engine counts (chromium-1181,
 * chromium_headless_shell-…).
 */
function browserPresent(
  browser: string,
  deps: Pick<
    PlaywrightProvisionDeps,
    "platform" | "home" | "env" | "listDir"
  > = {},
): boolean {
  const root = browsersRoot(
    deps.platform ?? process.platform,
    deps.home ?? homedir(),
    deps.env ?? process.env,
  );
  return (deps.listDir ?? safeListDir)(root).some((name) =>
    name.startsWith(browser),
  );
}

export async function provisionPlaywright(
  section: PlaywrightSection,
  deps: PlaywrightProvisionDeps = {},
): Promise<ProvisionOutcome> {
  const exec = deps.exec ?? runStep;
  const now = deps.now ?? Date.now;
  const pathExists = deps.pathExists ?? existsSync;
  const browser = section.browser ?? "chromium";

  if (section.endpoint ?? section.endpointFile) {
    return { status: "skipped", kind: "endpoint", actions: [], warnings: [] };
  }
  if (!MANAGED_ENGINES.has(browser)) {
    return {
      status: "skipped",
      kind: "system-channel",
      actions: [],
      warnings: [],
    };
  }
  if (section.autoProvision === false) {
    return { status: "skipped", kind: "managed", actions: [], warnings: [] };
  }

  if (browserPresent(browser, deps)) {
    return { status: "ready", kind: "managed", actions: [], warnings: [] };
  }

  const cli = deps.cliPath ?? defaultCliPath();
  if (!pathExists(cli)) {
    return {
      status: "failed",
      kind: "managed",
      actions: [],
      warnings: [
        `playwright-core CLI not found at ${cli} — reinstall dependencies (npm ci)`,
      ],
      error: "playwright-core missing",
    };
  }

  const statePath =
    deps.statePath ?? join(dirs.data, "playwright-provision.json");
  const state = loadProvisionState(statePath);
  // The pin key is the browser name: switching engines re-arms retries.
  if (!shouldAttempt(state, browser, now())) {
    return {
      status: "degraded",
      kind: "managed",
      actions: [],
      warnings: [
        `last ${browser} download failed (${state.lastError ?? "unknown"}); retrying with backoff`,
      ],
    };
  }

  const installed = await exec(process.execPath, [cli, "install", browser], {
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (!installed.ok) {
    const detail = failDetail(installed);
    // Linux-only failure class: the build downloaded but shared system
    // libraries are missing — that fix needs root, so it stays advisory.
    const depsHint = /missing dependencies|install-deps|apt-get/i.test(
      installed.stderr,
    )
      ? ` — system libraries are missing; run: sudo npx playwright install-deps ${browser}`
      : "";
    markProvisionFailure(statePath, state, browser, detail, now());
    return {
      status: "degraded",
      kind: "managed",
      actions: [],
      warnings: [
        `${browser} download failed (${detail})${depsHint} — browser tools will error until resolved`,
      ],
      error: detail,
    };
  }

  markProvisionSuccess(statePath, state, browser, now());
  return {
    status: "ready",
    kind: "managed",
    actions: [`downloaded ${browser} browser build`],
    warnings: [],
  };
}

/** Read-only doctor inspection: build present / endpoint mode. */
export function inspectPlaywright(
  section: PlaywrightSection,
  deps: PlaywrightProvisionDeps = {},
): DoctorCheck[] {
  if (section.endpoint ?? section.endpointFile) {
    return [
      {
        label: "Playwright: remote endpoint mode",
        status: "info",
        detail: "browser lives on the remote end",
      },
    ];
  }
  const browser = section.browser ?? "chromium";
  if (!MANAGED_ENGINES.has(browser)) {
    return [
      {
        label: `Playwright: system channel (${browser})`,
        status: "info",
        detail: "browser managed by the OS",
      },
    ];
  }
  return [
    browserPresent(browser, deps)
      ? { label: `Playwright ${browser} build present`, status: "ok" }
      : {
          label: `Playwright ${browser} build missing`,
          status: "warn",
          detail: "downloads automatically at next talon start",
          issue: true,
        },
  ];
}
