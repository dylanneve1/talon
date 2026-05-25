/**
 * Phase 7 — per-backend contract assertions.
 *
 * Every backend Talon ships routes through `adaptQueryBackend` until
 * the Phase 3.x native rewrites land. This test asserts each
 * adapted `Backend` honours the contract suite in
 * `core/agent-runtime/contract-tests.ts`: identity matches its id,
 * chat runs terminate, usage events fire exactly once, catalog
 * defaults shape correctly.
 *
 * Inputs are deliberately stubs (`wellBehavedLegacy()`) — exercising
 * the real factories would spawn subprocesses and hit network.
 * The conformance is over the adapter glue: we want to know that
 * the shape `claude` / `codex` / `kilo` / `opencode` / `openai-agents`
 * factories produce *can* round-trip through `adaptQueryBackend` and
 * pass every assertion. SDK-specific quirks live in per-backend
 * handler test files.
 */

import { describe, expect, it, vi } from "vitest";
import { adaptQueryBackend } from "../core/agent-runtime/adapter.js";
import {
  assertBackendContract,
  assertBackendIdentity,
} from "../core/agent-runtime/contract-tests.js";
import { BACKEND_IDS } from "../core/agent-runtime/model-ref.js";
import type { QueryBackend } from "../core/types.js";

function wellBehavedLegacy(): QueryBackend {
  return {
    query: vi.fn(async () => ({
      text: "ok",
      durationMs: 5,
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
    })),
    runOneShotAgent: vi.fn(async () => undefined),
    cacheMetrics: "readwrite",
    resolveModel: async (id: string) => ({
      kind: "exact" as const,
      storedValue: id,
      model: {
        id,
        displayName: id,
        provider: "stub",
        providerName: "Stub",
        selectable: true,
      },
    }),
    listModels: async () => ({
      models: [
        {
          id: "stub-1",
          displayName: "stub-1",
          provider: "stub",
          providerName: "Stub",
          selectable: true,
        },
      ],
      total: 1,
    }),
    getDefaultModel: () => "stub-default",
    getModelInfo: async (id: string) => ({
      id,
      displayName: id,
      provider: "stub",
      providerName: "Stub",
      selectable: true,
    }),
    getSessionSnapshot: async () => ({
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    resetChat: vi.fn(),
  } as QueryBackend;
}

describe("Phase 7 contract — every BackendId passes the suite via the adapter", () => {
  for (const id of BACKEND_IDS) {
    describe(id, () => {
      it("preserves identity through adaptQueryBackend", () => {
        const adapted = adaptQueryBackend(wellBehavedLegacy(), id, id);
        assertBackendIdentity(adapted, id);
      });

      it("passes every applicable contract", async () => {
        const adapted = adaptQueryBackend(wellBehavedLegacy(), id, id);
        const checks = await assertBackendContract(adapted, {
          chatId: `contract-${id}`,
          text: "ping",
        });
        // Every well-behaved stub exercises the full contract surface
        // — chat, models, usage. The background runner contract runs
        // too because the stub implements runOneShotAgent.
        expect(checks).toContain("ChatBackend.emitsRunStarted");
        expect(checks).toContain("ChatBackend.terminates");
        expect(checks).toContain("ChatBackend.singleUsage");
        expect(checks).toContain("ChatBackend.completedUsageMatches");
        expect(checks).toContain("BackgroundRunner.lifecycle");
        expect(checks).toContain("ModelCatalog.defaultShape");
        expect(checks).toContain("UsageTelemetry.shape");
      });

      it("exposes a capabilities flag set matching the adapted slots", () => {
        const adapted = adaptQueryBackend(wellBehavedLegacy(), id, id);
        expect(adapted.capabilities.chat).toBe(true);
        expect(adapted.capabilities.background).toBe(true);
        expect(adapted.capabilities.models).toBe(true);
        expect(adapted.capabilities.sessions).toBe(true);
        expect(adapted.capabilities.usage).toBe(true);
      });
    });
  }
});
