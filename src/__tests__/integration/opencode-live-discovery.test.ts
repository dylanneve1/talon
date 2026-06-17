/**
 * Live-server integration test for the OpenCode backend.
 *
 * Spawns a real `opencode serve` subprocess on a dedicated port, reads the
 * live provider/auth endpoints through @opencode-ai/sdk v2, and runs that data
 * through Talon's OpenCode catalog parser. This complements the fixture-based
 * unit tests by catching CLI/SDK/schema drift against the real deployed
 * backend binary.
 *
 * Ordinary test runs skip this suite if `opencode` is not available. CI
 * installs the matching `opencode-ai` CLI and sets OPENCODE_LIVE_REQUIRED=1
 * plus OPENCODE_EXECUTABLE, so the backend cannot silently skip there.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  cliAvailable,
  spawnCli,
  stopProcess,
  waitForHealthy,
} from "./live-backend-helpers.js";

type OpenCodeModelsModule =
  typeof import("../../backend/opencode/models/index.js");

const OPENCODE_EXECUTABLE_ENV = "OPENCODE_EXECUTABLE";
const OPENCODE_PRESENT = cliAvailable("opencode", OPENCODE_EXECUTABLE_ENV);
const OPENCODE_REQUIRED = process.env.OPENCODE_LIVE_REQUIRED === "1";
const opencodeDescribe =
  OPENCODE_PRESENT || OPENCODE_REQUIRED ? describe : describe.skip;

const TEST_PORT = Number(process.env.OPENCODE_TEST_PORT ?? 4197);
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const HEALTH_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 45_000;

let opencodeProc: ChildProcess | null = null;
let testClient: OpencodeClient;
let getOpenCodeModelCatalog: OpenCodeModelsModule["getOpenCodeModelCatalog"];
let getOpenCodeModelSelectionValue: OpenCodeModelsModule["getOpenCodeModelSelectionValue"];
let resolveOpenCodeModelInput: OpenCodeModelsModule["resolveOpenCodeModelInput"];
let clearModelCatalogCache: OpenCodeModelsModule["clearModelCatalogCache"];

vi.mock("../../backend/opencode/server.js", () => {
  return {
    ensureServer: vi.fn(async (): Promise<OpencodeClient> => {
      if (!testClient) {
        throw new Error(
          "ensureServer called before opencode-live beforeAll initialised testClient",
        );
      }
      return testClient;
    }),
  };
});

vi.mock("../../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

opencodeDescribe("OpenCode live discovery (integration)", () => {
  beforeAll(async () => {
    if (!OPENCODE_PRESENT) {
      throw new Error(
        "OpenCode CLI is required for this test but `opencode --version` failed. Install opencode-ai or unset OPENCODE_LIVE_REQUIRED.",
      );
    }

    ({
      getOpenCodeModelCatalog,
      getOpenCodeModelSelectionValue,
      resolveOpenCodeModelInput,
      clearModelCatalogCache,
    } = await import("../../backend/opencode/models/index.js"));

    opencodeProc = spawnCli(
      "opencode",
      [
        "serve",
        "--hostname=127.0.0.1",
        `--port=${TEST_PORT}`,
        "--log-level=ERROR",
      ],
      OPENCODE_EXECUTABLE_ENV,
    );

    let stdout = "";
    let stderr = "";
    opencodeProc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    opencodeProc.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    opencodeProc.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
    });

    try {
      await waitForHealthy(BASE_URL, HEALTH_TIMEOUT_MS);
    } catch (err) {
      throw new Error(
        `${(err as Error).message}\nopencode stdout:\n${stdout || "(empty)"}\nopencode stderr:\n${stderr || "(empty)"}`,
      );
    }

    testClient = createOpencodeClient({
      baseUrl: BASE_URL,
      throwOnError: true,
    });
    clearModelCatalogCache();
  }, HEALTH_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await stopProcess(opencodeProc);
    opencodeProc = null;
  });

  it("opencode serve responds to /global/health", async () => {
    const resp = await fetch(`${BASE_URL}/global/health`);
    expect(resp.ok).toBe(true);
    const body = (await resp.json()) as { healthy?: boolean };
    expect(body.healthy).toBe(true);
  });

  it("provider.list() returns live provider metadata", async () => {
    const resp = await testClient.provider.list();
    const data = resp.data as {
      all?: Array<unknown>;
      connected?: Array<string>;
      default?: Record<string, string>;
    };
    expect(Array.isArray(data.all)).toBe(true);
    expect((data.all ?? []).length).toBeGreaterThan(0);
    expect(Array.isArray(data.connected)).toBe(true);
    expect(typeof data.default).toBe("object");
  });

  it("provider.auth() returns live auth metadata", async () => {
    const resp = await testClient.provider.auth();
    const data =
      (resp.data as Record<string, Array<{ type?: string }>> | undefined) ?? {};
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it("getOpenCodeModelCatalog() parses live data without throwing", async () => {
    const catalog = await getOpenCodeModelCatalog(true);
    expect(catalog.providers.length).toBeGreaterThan(0);
    expect(catalog.models.length).toBeGreaterThan(0);
  });

  it("round-trips a live model id through resolveOpenCodeModelInput", async () => {
    const catalog = await getOpenCodeModelCatalog();
    const sample = catalog.connectedModels[0] ?? catalog.models[0];
    expect(sample).toBeDefined();

    const selection = getOpenCodeModelSelectionValue(sample, catalog);
    const resolution = resolveOpenCodeModelInput(selection, catalog);
    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") return;
    expect(resolution.model.id).toBe(sample.id);
    expect(resolution.model.providerID).toBe(sample.providerID);
  });

  it("caches the catalog within the TTL window", async () => {
    const a = await getOpenCodeModelCatalog();
    const b = await getOpenCodeModelCatalog();
    expect(b).toBe(a);
  });

  it("forceRefresh bypasses the cache", async () => {
    const a = await getOpenCodeModelCatalog();
    const b = await getOpenCodeModelCatalog(true);
    expect(b).not.toBe(a);
  });
});
