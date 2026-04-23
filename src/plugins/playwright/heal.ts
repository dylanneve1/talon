/**
 * Playwright MCP self-heal.
 *
 * Two components to verify/install:
 *   1. The `@playwright/mcp` npm package. Pinned in Talon's package.json;
 *      `npm install` is the source of truth. We only probe + report drift.
 *      We intentionally do NOT mutate node_modules at runtime — that would
 *      desync with the lockfile and surface weird behavior after the next
 *      `npm ci`.
 *   2. The browser binary for the chosen browser (chromium / firefox /
 *      webkit / chrome / msedge). These live outside node_modules and are
 *      installed by `npx playwright install <browser>`. Each is hundreds
 *      of MB, so we only install the one the user actually configured.
 *
 * When the plugin is configured with a remote `endpoint` (e.g. bring-your-
 * own-browser websocket), there's no local browser to manage and heal
 * skips straight to success.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as pathResolve } from "node:path";
import {
  runProbe,
  runStreaming,
  type RunOptions,
} from "../common/subprocess.js";
import type { HealContext, HealFn, HealResult } from "../common/lifecycle.js";
import type { PluginError } from "../common/errors.js";

/**
 * Pinned `@playwright/mcp` version. MUST match the pin in Talon's
 * package.json. Both sites get updated together when bumping the
 * upstream release — CI smoke verifies they agree.
 *
 * @see https://github.com/microsoft/playwright-mcp/releases
 */
export const PLAYWRIGHT_MCP_VERSION = "0.0.70";

export const SUPPORTED_BROWSERS = [
  "chromium",
  "chrome",
  "firefox",
  "webkit",
  "msedge",
] as const;

export type SupportedBrowser = (typeof SUPPORTED_BROWSERS)[number];

export interface PlaywrightHealOpts {
  /** Absolute path to @playwright/mcp/cli.js in node_modules. */
  mcpBin: string;
  /** Browser to verify + install locally. Omit when using a remote endpoint. */
  browser?: SupportedBrowser;
  /** Expected CLI version (override for testing). */
  expectedVersion?: string;
}

function runOpts(
  ctx: HealContext,
  tracker: RunOptions["tracker"],
  timeoutMs: number,
): RunOptions {
  return { timeoutMs, tracker, spawnImpl: ctx.spawnImpl };
}

function failed(
  identifier: string,
  error: PluginError,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "failed", identifier, error, elapsedMs, summary };
}

function healthy(
  identifier: string,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "healthy", identifier, elapsedMs, summary };
}

function degraded(
  identifier: string,
  error: PluginError,
  elapsedMs: number,
  summary: readonly string[],
): HealResult {
  return { status: "degraded", identifier, error, elapsedMs, summary };
}

/** Read version from @playwright/mcp/package.json next to the CLI. */
export function detectInstalledMcpVersion(mcpBin: string): string | null {
  try {
    const pkgJson = pathResolve(dirname(mcpBin), "package.json");
    if (!existsSync(pkgJson)) return null;
    const parsed = JSON.parse(readFileSync(pkgJson, "utf-8")) as {
      version?: string;
    };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `npx` executable name. On Windows, npm ships `npx.cmd` rather
 * than `npx` and Node's `spawn` doesn't auto-resolve `.cmd` extensions
 * without `shell: true` — so we have to pick the right name explicitly.
 */
const NPX_BIN = process.platform === "win32" ? "npx.cmd" : "npx";

/**
 * Probe `npx playwright install --dry-run <browser>`. Playwright prints
 * "is already installed" or otherwise shows "downloading" / "will download"
 * when the binary is missing. We only trust the positive signal to avoid
 * re-downloading hundreds of MB on a false negative.
 */
async function isBrowserInstalled(
  browser: SupportedBrowser,
  ctx: HealContext,
): Promise<boolean> {
  const result = await runProbe(
    NPX_BIN,
    ["playwright", "install", "--dry-run", browser],
    { timeoutMs: 60_000, spawnImpl: ctx.spawnImpl },
  );
  if (result === null) return false;
  const combined = result.toLowerCase();
  if (
    combined.includes("downloading") ||
    combined.includes("will download") ||
    combined.includes("not found")
  ) {
    return false;
  }
  return combined.includes(browser.toLowerCase());
}

export function createPlaywrightHeal(opts: PlaywrightHealOpts): HealFn {
  return async (ctx: HealContext): Promise<HealResult> => {
    const { logger } = ctx;
    const existsSyncImpl =
      ctx.existsSyncImpl ??
      ((await import("node:fs")).existsSync as (path: string) => boolean);
    const summary: string[] = [];
    const start = Date.now();
    const expectedVersion = opts.expectedVersion ?? PLAYWRIGHT_MCP_VERSION;

    // ── Step 1: MCP CLI present ───────────────────────────────────────
    const binStep = logger.step("locate @playwright/mcp CLI");
    if (!existsSyncImpl(opts.mcpBin)) {
      binStep.fail(`not found at ${opts.mcpBin}`);
      return failed(
        `@playwright/mcp ${expectedVersion}`,
        {
          kind: "executable-not-found",
          message: `@playwright/mcp CLI not found at ${opts.mcpBin}`,
          hint: "run 'npm install' in the Talon checkout",
        },
        Date.now() - start,
        summary,
      );
    }
    binStep.ok(`cli: ${opts.mcpBin}`);

    // ── Step 2: version matches pin? ──────────────────────────────────
    const versionStep = logger.step("verify @playwright/mcp version");
    const installedVersion = detectInstalledMcpVersion(opts.mcpBin);
    if (installedVersion === null) {
      versionStep.fail("could not read @playwright/mcp/package.json");
      return failed(
        `@playwright/mcp ?`,
        {
          kind: "unknown",
          message: "@playwright/mcp installed but package.json unreadable",
          hint: "reinstall with 'npm ci' in the Talon checkout",
        },
        Date.now() - start,
        summary,
      );
    }
    if (installedVersion !== expectedVersion) {
      versionStep.fail(
        `installed ${installedVersion} ≠ pinned ${expectedVersion}`,
      );
      return failed(
        `@playwright/mcp ${installedVersion}`,
        {
          kind: "version-mismatch",
          message: `@playwright/mcp ${installedVersion} is installed but Talon pins ${expectedVersion}`,
          hint: "run 'npm install' in the Talon checkout — we don't mutate node_modules at runtime",
        },
        Date.now() - start,
        summary,
      );
    }
    versionStep.ok(`@playwright/mcp ${installedVersion} matches pin`);
    summary.push(`@playwright/mcp ${installedVersion}`);

    // ── Step 3: browser check (skipped for remote endpoints) ──────────
    if (!opts.browser) {
      const remoteStep = logger.step("browser");
      remoteStep.skip("remote endpoint configured — no local browser needed");
      summary.push("browser: remote endpoint");
      return healthy(
        `@playwright/mcp ${installedVersion}`,
        Date.now() - start,
        summary,
      );
    }

    if (!SUPPORTED_BROWSERS.includes(opts.browser)) {
      const unsupportedStep = logger.step("validate browser name");
      unsupportedStep.fail(`unsupported browser: ${opts.browser}`);
      return failed(
        `@playwright/mcp ${installedVersion}`,
        {
          kind: "version-mismatch",
          message: `unsupported browser "${opts.browser}"`,
          hint: `choose one of: ${SUPPORTED_BROWSERS.join(", ")}`,
        },
        Date.now() - start,
        summary,
      );
    }

    const probeStep = logger.step(`probe ${opts.browser} binary`);
    const installed = await isBrowserInstalled(opts.browser, ctx);
    probeStep.ok(installed ? "present" : "missing");

    if (!installed) {
      // ── Step 4: install missing browser ─────────────────────────────
      const installStep = logger.step(`install ${opts.browser}`);
      const result = await runStreaming(
        NPX_BIN,
        ["playwright", "install", opts.browser],
        runOpts(ctx, installStep, 10 * 60_000),
      );
      if (!result.ok) {
        installStep.fail(result.error?.message ?? "playwright install failed");
        return failed(
          `@playwright/mcp ${installedVersion}`,
          result.error ?? {
            kind: "unknown",
            message: `playwright install ${opts.browser} failed`,
            hint: "retry once; if persistent, try 'npx playwright install --with-deps'",
          },
          Date.now() - start,
          summary,
        );
      }
      installStep.ok();

      // Re-probe to confirm
      const confirmStep = logger.step(`confirm ${opts.browser} after install`);
      const nowInstalled = await isBrowserInstalled(opts.browser, ctx);
      if (!nowInstalled) {
        confirmStep.fail("still reports as not installed");
        return degraded(
          `@playwright/mcp ${installedVersion}`,
          {
            kind: "unknown",
            message: `playwright install ${opts.browser} claimed success but --dry-run still reports missing`,
            hint: "inspect ~/.cache/ms-playwright and re-run manually",
          },
          Date.now() - start,
          summary,
        );
      }
      confirmStep.ok();
      summary.push(`browser: ${opts.browser} (fresh install)`);
    } else {
      summary.push(`browser: ${opts.browser} (present)`);
    }

    return healthy(
      `@playwright/mcp ${installedVersion} + ${opts.browser}`,
      Date.now() - start,
      summary,
    );
  };
}
