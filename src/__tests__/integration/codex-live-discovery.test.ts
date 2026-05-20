/**
 * Live Codex CLI / Codex SDK integration test.
 *
 * Codex has no long-running HTTP daemon — unlike Kilo and OpenCode, where
 * the live test spawns `<backend> serve` and probes a real `/provider`
 * endpoint, Codex spawns the `codex` CLI as a subprocess per `runStreamed`
 * call. The deployment seam that fixture tests can't represent is
 * therefore narrower:
 *
 *   1. The `codex` CLI is installed and reports a version.
 *   2. `@openai/codex-sdk` and the installed `codex` binary stay in
 *      lockstep across releases (the SDK pins the CLI to an exact version
 *      in its own `dependencies`; CI installs that version explicitly).
 *   3. The SDK's `Codex` class can construct + `startThread()` against
 *      Talon's threadOptions WITHOUT requiring an API key — auth is only
 *      consulted on `runStreamed`. Construction failures here would
 *      surface in production at the first turn instead of at startup.
 *   4. The Codex MCP-config flattening (`buildCodexMcpServers`) produces
 *      a config object the SDK accepts as a TOML-shaped override.
 *   5. Talon's catalog (`backend/codex/models.ts`) is non-empty and round-
 *      trips through `resolveModel` for the flagship model id.
 *
 * Skipping:
 *   Ordinary local test runs skip the suite if `codex --version` fails.
 *   The dedicated CI job sets `CODEX_LIVE_REQUIRED=1` after installing
 *   `@openai/codex` at the SDK-pinned version, so missing CLI / drift
 *   fails there instead of silently skipping.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Codex } from "@openai/codex-sdk";
import {
  cliAvailable,
  cliCommand,
  cliVersion,
} from "./live-backend-helpers.js";
import { buildCodexMcpServers } from "../../backend/codex/mcp-config.js";
import {
  CODEX_MODELS,
  getModelInfo,
  resolveModel,
} from "../../backend/codex/models.js";
import { CODEX_DEFAULT_MODEL } from "../../backend/codex/constants.js";

// `@openai/codex-sdk` only exposes `.` via its `exports` field — no
// `./package.json` subpath and no legacy `main`, so neither
// `import('@openai/codex-sdk/package.json')` nor `require.resolve()`
// works to locate it. Walk up from this test file to `node_modules`
// and read it directly. The package.json is the canonical source for
// SDK version + the `@openai/codex` CLI version pin.
function readSdkPackageJson(): {
  version: string;
  dependencies?: Record<string, string>;
} {
  // Climb from .../src/__tests__/integration to the repo root, then
  // jump into node_modules. `import.meta.url` is the test file URL.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const pkgPath = join(
    repoRoot,
    "node_modules",
    "@openai",
    "codex-sdk",
    "package.json",
  );
  return JSON.parse(readFileSync(pkgPath, "utf8")) as {
    version: string;
    dependencies?: Record<string, string>;
  };
}

const CODEX_EXECUTABLE_ENV = "CODEX_CODE_EXECUTABLE";
const CODEX_PRESENT = cliAvailable("codex", CODEX_EXECUTABLE_ENV);
const CODEX_REQUIRED = process.env.CODEX_LIVE_REQUIRED === "1";
const codexDescribe =
  CODEX_PRESENT || CODEX_REQUIRED ? describe : describe.skip;

// Parse the `codex-cli 0.130.0` / `codex 0.130.0` / `Codex 0.130.0` style
// version string the CLI emits. Tolerant of leading product label.
function extractSemverFromCliOutput(s: string): string | null {
  const m = s.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/);
  return m ? m[1] : null;
}

codexDescribe("Codex SDK live discovery (integration)", () => {
  // ── 1. CLI is present + reports a version. ──────────────────────────────
  it("has a real Codex CLI available", () => {
    if (!CODEX_PRESENT) {
      throw new Error(
        "Codex CLI is required for this test but `codex --version` failed. Install @openai/codex or unset CODEX_LIVE_REQUIRED.",
      );
    }

    const version = cliVersion("codex", CODEX_EXECUTABLE_ENV);
    // CLI prints something like `codex-cli 0.130.0` — match case-insensitively
    // and just confirm the word `codex` shows up alongside a semver.
    expect(version).toMatch(/codex/i);
    expect(extractSemverFromCliOutput(version)).toMatch(/^\d+\.\d+\.\d+/);
  });

  // ── 2. SDK ↔ CLI version lockstep. ──────────────────────────────────────
  // The most operationally important live check for Codex: the SDK pins
  // the CLI to an exact version via its own `@openai/codex` dependency.
  // If a release ships with a mismatched CLI, runStreamed crashes with
  // confusing errors in production. Catching it here fails CI loudly.
  it("SDK package version matches the installed CLI version", () => {
    // Read the SDK's own pinned CLI version from its package.json.
    const sdkPkg = readSdkPackageJson();
    const sdkVersion = sdkPkg.version;
    const pinnedCliVersion = sdkPkg.dependencies?.["@openai/codex"];

    expect(sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    // The SDK MUST pin its CLI dep; otherwise the install-backend-cli
    // script can't reliably pick the matching version.
    expect(pinnedCliVersion).toBeTruthy();

    const cliVer = extractSemverFromCliOutput(
      cliVersion("codex", CODEX_EXECUTABLE_ENV),
    );
    expect(cliVer).not.toBeNull();
    // Allow either an exact match (CI normal case) or the case where the
    // SDK ships an SDK-only patch — in which case the CLI is at the
    // pinned version, not the SDK's own version.
    expect(cliVer).toBe(pinnedCliVersion);
  });

  // ── 3. SDK constructs without an API key. ───────────────────────────────
  // Talon's `initCodexAgent` builds a `Codex` instance per chat at startup
  // (lazily, via `ensureCodex`). If construction itself required auth, the
  // first turn would fail in a surprising way. Verify the contract.
  it("Codex SDK constructs without requiring auth", () => {
    // No apiKey, no config — should still construct.
    expect(() => new Codex()).not.toThrow();

    // With Talon's typical config-only path.
    expect(
      () =>
        new Codex({
          config: { mcp_servers: {} },
        }),
    ).not.toThrow();

    // With a path override (mirrors what Talon could pass if it threaded
    // CODEX_CODE_EXECUTABLE through — currently it doesn't, but the SDK
    // option exists and the test exercises it).
    const override = process.env[CODEX_EXECUTABLE_ENV];
    if (override) {
      expect(
        () =>
          new Codex({
            codexPathOverride: override,
            config: { mcp_servers: {} },
          }),
      ).not.toThrow();
    }
  });

  // ── 4. startThread() yields a Thread shape Talon can drive. ─────────────
  // No `runStreamed` call here — that requires an API key. We just verify
  // the synchronous side of the SDK that Talon's handler calls every
  // turn.
  it("Codex.startThread returns a Thread that exposes runStreamed", () => {
    const codex = new Codex({ config: { mcp_servers: {} } });
    const thread = codex.startThread({
      model: CODEX_DEFAULT_MODEL,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
    });

    expect(thread).toBeTruthy();
    // The handler reads these off the Thread; runtime contracts.
    expect(typeof thread.runStreamed).toBe("function");
    // `resumeThread` is a method on `Codex`, not on the Thread, but
    // verify the symmetric construction works too.
    expect(typeof codex.resumeThread).toBe("function");
  });

  // ── 5. buildCodexMcpServers produces a config the SDK accepts. ──────────
  // The Codex CLI's `--config` flag flattens nested JSON into TOML. The
  // SDK forwards `options.config` verbatim; if Talon's flattening output
  // ever drifts from what the SDK's type expects (e.g. nested objects vs
  // dotted keys), the type system catches it at compile time but
  // construction may still throw at runtime. Verify it doesn't.
  it("buildCodexMcpServers output is accepted as a Codex config", () => {
    const servers = buildCodexMcpServers({
      chatId: "live-test-chat",
      bridgeUrl: "http://127.0.0.1:19876",
      frontends: ["telegram"],
    });
    // We expect at least the telegram-tools frontend server (no plugins
    // configured in this test process, so plugin servers are empty).
    expect(servers["telegram-tools"]).toBeDefined();

    expect(
      () =>
        new Codex({
          config: {
            mcp_servers: servers as unknown as Record<string, never>,
          },
        }),
    ).not.toThrow();
  });

  // ── 6. Catalog round-trip with the live SDK in scope. ───────────────────
  // Sanity-check that Talon's hand-maintained Codex model catalog still
  // resolves its own default. If the SDK ever introduces dynamic model
  // discovery (it currently doesn't), this is the test that flags the
  // gap.
  it("CODEX_DEFAULT_MODEL is in the catalog and round-trips through resolveModel", async () => {
    expect(CODEX_MODELS.length).toBeGreaterThan(0);
    const direct = await getModelInfo(CODEX_DEFAULT_MODEL);
    expect(direct?.id).toBe(CODEX_DEFAULT_MODEL);

    const resolution = await resolveModel(CODEX_DEFAULT_MODEL);
    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.id).toBe(CODEX_DEFAULT_MODEL);
    // Every entry in the catalog should be reachable from the registered
    // command surface.
    for (const m of CODEX_MODELS) {
      expect(m.selectable).toBe(true);
      expect(m.provider).toBe("openai");
    }
  });

  // ── 7. The installed binary on PATH matches what `cliCommand` resolves. ─
  // Sanity check: in CI, `install-backend-cli.mjs` writes the global bin
  // dir to GITHUB_PATH AND exports `CODEX_CODE_EXECUTABLE` to the
  // explicit binary path. We should be able to invoke whichever
  // `cliCommand` returns and have it work. Hands a regression on the
  // resolution helper.
  it("cliCommand resolves to a binary that runs --version", () => {
    const command = cliCommand("codex", CODEX_EXECUTABLE_ENV);
    expect(command).toBeTruthy();
    expect(typeof command).toBe("string");
    // Should not throw — `cliVersion` runs the resolved command.
    expect(() => cliVersion("codex", CODEX_EXECUTABLE_ENV)).not.toThrow();
  });
});
