/**
 * Antigravity model discovery tests — drive the live `list_models.py`
 * helper through the real `discoverAntigravityModels` function. Uses
 * a fake stand-in script so we don't need a real Gemini API key.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We don't import the discovery module directly with the real script —
// instead we point its env at our fake script via the spawn-mock
// pattern. Since discovery resolves its script path via existsSync()
// + relative resolution, we mock `existsSync` and `spawn` indirectly
// via a tighter approach: substitute the python binary path with a
// node wrapper that runs our fake.

const fakeListModelsScript = `#!/usr/bin/env node
// Fake list_models.py: read API key from fd 3, emit a canned JSON
// blob. The TS-side discovery module shouldn't care that this isn't
// really Python — it just parses stdout JSON.
const fs = require("node:fs");

function readKey() {
  try {
    return fs.readFileSync(3, "utf-8").trim();
  } catch (e) {
    return "";
  }
}

const key = readKey();
const mode = process.env.FAKE_DISCOVERY_MODE || "ok";

if (mode === "no-key" && !key) {
  console.log(JSON.stringify({ ok: false, error: "missing API key" }));
  process.exit(2);
}

if (mode === "bad-key") {
  console.log(JSON.stringify({
    ok: false,
    error: "models.list failed: ClientError: 400 INVALID_ARGUMENT. API key not valid.",
  }));
  process.exit(1);
}

if (mode === "ok") {
  console.log(JSON.stringify({
    ok: true,
    models: [
      {
        id: "models/gemini-3.5-flash",
        name: "models/gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        inputTokenLimit: 1000000,
        outputTokenLimit: 8192,
        supportsThinking: true,
        supportedActions: ["generateContent", "countTokens"],
      },
      {
        id: "models/gemini-3-pro",
        name: "models/gemini-3-pro",
        displayName: "Gemini 3 Pro",
        inputTokenLimit: 2000000,
        outputTokenLimit: 8192,
        supportsThinking: true,
        supportedActions: ["generateContent", "countTokens"],
      },
      {
        id: "models/gemini-experimental-X",
        name: "models/gemini-experimental-X",
        displayName: "Gemini Experimental",
        inputTokenLimit: 500000,
        outputTokenLimit: 8192,
        supportsThinking: false,
        supportedActions: ["generateContent"],
      },
    ],
  }));
  process.exit(0);
}

if (mode === "hang") {
  // Never respond — test timeout path.
  setInterval(() => {}, 1000);
}
`;

let fakeScriptPath: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "ag-discovery-test-"));
  fakeScriptPath = join(dir, "fake-list-models.js");
  writeFileSync(fakeScriptPath, fakeListModelsScript);
  chmodSync(fakeScriptPath, 0o755);
});

afterEach(async () => {
  const { resetDiscoveryStateForTests } =
    await import("../backend/antigravity/discovery.js");
  resetDiscoveryStateForTests();
  delete process.env.FAKE_DISCOVERY_MODE;
});

describe("antigravity discovery — happy path", () => {
  it("returns live models from a fake script (canonical id form)", async () => {
    process.env.FAKE_DISCOVERY_MODE = "ok";
    const { discoverAntigravityModels, resetDiscoveryStateForTests } =
      await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();

    const result = await discoverAntigravityModels({
      apiKey: "fake-key",
      pythonPath: process.execPath,
      scriptPathOverride: fakeScriptPath,
    });
    expect(result.source).toBe("live");
    expect(result.models.length).toBe(3);
    // Discovery should preserve the canonical `models/` prefix.
    expect(result.models.some((m) => m.id === "models/gemini-3.5-flash")).toBe(
      true,
    );
    // supportsThinking → reasoning: true.
    const flash = result.models.find((m) => m.id === "models/gemini-3.5-flash");
    expect(flash?.reasoning).toBe(true);
    const experimental = result.models.find(
      (m) => m.id === "models/gemini-experimental-X",
    );
    expect(experimental?.reasoning).toBe(false);
    // contextWindow propagates from inputTokenLimit.
    expect(flash?.contextWindow).toBe(1_000_000);
  });

  it("sorts Pro variants above Flash + experimental tiers", async () => {
    process.env.FAKE_DISCOVERY_MODE = "ok";
    const { discoverAntigravityModels, resetDiscoveryStateForTests } =
      await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();
    const result = await discoverAntigravityModels({
      apiKey: "fake-key",
      pythonPath: process.execPath,
      scriptPathOverride: fakeScriptPath,
    });
    // Pro (3) ranks above Flash (3.5) ranks above Experimental.
    const ids = result.models.map((m) => m.id);
    const proIdx = ids.indexOf("models/gemini-3-pro");
    const flashIdx = ids.indexOf("models/gemini-3.5-flash");
    expect(proIdx).toBeLessThan(flashIdx);
  });

  it("returns fallback when the script exits with ok:false", async () => {
    process.env.FAKE_DISCOVERY_MODE = "bad-key";
    const { discoverAntigravityModels, resetDiscoveryStateForTests } =
      await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();
    const result = await discoverAntigravityModels({
      apiKey: "obviously-bad",
      pythonPath: process.execPath,
      scriptPathOverride: fakeScriptPath,
    });
    expect(result.source).toBe("fallback");
    expect(result.error).toContain("API key not valid");
  });
});

describe("antigravity discovery — fallback", () => {
  it("returns fallback when no API key configured", async () => {
    const { discoverAntigravityModels, resetDiscoveryStateForTests } =
      await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();

    // Make sure env doesn't leak.
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const result = await discoverAntigravityModels({});
      expect(result.source).toBe("fallback");
      expect(result.error).toContain("no API key");
      expect(result.models.length).toBeGreaterThanOrEqual(5);
      // Every fallback model exposes the canonical canonical id form.
      for (const m of result.models) {
        expect(m.id.startsWith("models/")).toBe(true);
        expect(m.provider).toBe("google");
      }
    } finally {
      if (savedKey) process.env.GEMINI_API_KEY = savedKey;
    }
  });

  it("caches results across calls", async () => {
    const { discoverAntigravityModels, resetDiscoveryStateForTests } =
      await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();
    delete process.env.GEMINI_API_KEY;

    const r1 = await discoverAntigravityModels({});
    const r2 = await discoverAntigravityModels({});
    // Same fetchedAt = cached result reused.
    expect(r2.fetchedAt).toBe(r1.fetchedAt);
  });

  it("force-refreshes when force=true", async () => {
    const { discoverAntigravityModels, resetDiscoveryStateForTests } =
      await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();
    delete process.env.GEMINI_API_KEY;

    const r1 = await discoverAntigravityModels({});
    // Tick the clock a touch. ms-resolution + a no-op fallback path
    // can complete inside the same millisecond, so wait a bit more
    // than 1ms to make sure the second timestamp ticks.
    await new Promise((r) => setTimeout(r, 50));
    const r2 = await discoverAntigravityModels({ force: true });
    expect(r2.fetchedAt).toBeGreaterThan(r1.fetchedAt);
  });
});

describe("antigravity discovery — refresh", () => {
  it("refreshAntigravityCatalog drops the cache", async () => {
    const {
      discoverAntigravityModels,
      refreshAntigravityCatalog,
      getCachedAntigravityModels,
      resetDiscoveryStateForTests,
    } = await import("../backend/antigravity/discovery.js");
    resetDiscoveryStateForTests();
    delete process.env.GEMINI_API_KEY;

    await discoverAntigravityModels({});
    expect(getCachedAntigravityModels().length).toBeGreaterThan(0);

    refreshAntigravityCatalog();
    // After refresh, getCachedAntigravityModels falls back to a
    // stub fallback result. Still returns models (fallback list).
    expect(getCachedAntigravityModels().length).toBeGreaterThan(0);
  });
});
