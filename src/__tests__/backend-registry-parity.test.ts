/**
 * Backend registry parity tests.
 *
 * Verifies that all built-in backends (Claude SDK, Kilo, OpenCode, Codex,
 * OpenAI Agents) register themselves into the registry
 * with the same QueryBackend surface — so the dispatcher can swap
 * backends without leaking backend-specific behaviour upstream.
 *
 * Each backend factory's `init(config, ctx)` returns a `QueryBackend`
 * whose required + optional methods Talon's core relies on. This file
 * doesn't actually CALL `init` (it would spawn real subprocesses);
 * instead it verifies registry presence + factory shape.
 */

import { describe, it, expect, beforeAll } from "vitest";

import {
  clearBackends,
  getBackend,
  listBackends,
  hasBackend,
} from "../backend/registry.js";

const ALL_BACKENDS = [
  "claude",
  "kilo",
  "opencode",
  "codex",
  "openai-agents",
] as const;

beforeAll(async () => {
  // Reset registry for a clean import. Each factory module's
  // side-effect import re-registers it.
  clearBackends();
  await import("../backend/claude-sdk/factory.js");
  await import("../backend/kilo/factory.js");
  await import("../backend/opencode/factory.js");
  await import("../backend/codex/factory.js");
  await import("../backend/openai-agents/factory.js");
}, 30_000);

describe("backend registry parity — all built-in backends present", () => {
  it("registers Claude, Kilo, OpenCode, Codex, and OpenAI Agents", () => {
    for (const id of ALL_BACKENDS) {
      expect(hasBackend(id), `expected backend "${id}" registered`).toBe(true);
    }
  });

  it("listBackends returns them sorted by id", () => {
    const ids = listBackends().map((b) => b.id);
    expect(ids).toContain("claude");
    expect(ids).toContain("codex");
    expect(ids).toContain("kilo");
    expect(ids).toContain("opencode");
    expect(ids).toContain("openai-agents");
    // Sorted property: ids should equal their sorted-copy
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("every backend has a non-empty label", () => {
    for (const id of ALL_BACKENDS) {
      const factory = getBackend(id);
      expect(factory, `factory for ${id}`).toBeDefined();
      expect(factory!.label.length).toBeGreaterThan(0);
    }
  });

  it("every backend factory has an init function", () => {
    for (const id of ALL_BACKENDS) {
      const factory = getBackend(id);
      expect(typeof factory!.init).toBe("function");
    }
  });

  it("expected labels", () => {
    expect(getBackend("claude")?.label).toBe("Anthropic");
    expect(getBackend("kilo")?.label).toBe("Kilo");
    expect(getBackend("opencode")?.label).toBe("OpenCode");
    expect(getBackend("codex")?.label).toBe("Codex");
    expect(getBackend("openai-agents")?.label).toBe("OpenAI Agents");
  });
});

describe("backend registry parity — duplicate registration is rejected", () => {
  it("re-registering an existing id throws", async () => {
    const { registerBackend } = await import("../backend/registry.js");
    expect(() =>
      registerBackend({
        id: "claude",
        label: "Duplicate",
        init: async () => ({ backend: {} as never }),
      }),
    ).toThrow(/already registered/);
  });
});
