/**
 * Phase 5 — `ToolRegistry` builder over the legacy `ALL_TOOLS`
 * catalog.
 *
 * Pins the conversion shape every Phase 5.x backend renderer will
 * depend on: each `ToolDefinition` produces a `ToolDescriptor` with
 * the legacy `tag` propagated, `delivery` from `endsTurn`,
 * `requiresAmbientChat` inferred from the frontend allowlist, and
 * `readOnly` inferred from the tag.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../core/tools/index.js";
import {
  buildToolRegistryFromCatalog,
  getGlobalToolRegistry,
  resetGlobalToolRegistry,
  toolDefinitionToDescriptor,
} from "../core/agent-runtime/tool-registry-builder.js";
import { defaultRunPolicyFor } from "../core/agent-runtime/run-policy.js";

describe("buildToolRegistryFromCatalog", () => {
  it("registers every catalog tool exactly once", () => {
    const reg = buildToolRegistryFromCatalog();
    expect(reg.size()).toBe(ALL_TOOLS.length);
    for (const tool of ALL_TOOLS) {
      expect(reg.has(tool.name)).toBe(true);
    }
  });

  it("propagates tag, description, delivery, requiresAmbientChat", () => {
    const terminator = ALL_TOOLS.find((t) => t.endsTurn === true);
    expect(terminator).toBeDefined();
    const desc = toolDefinitionToDescriptor(terminator!);
    expect(desc.id).toBe(terminator!.name);
    expect(desc.name).toBe(terminator!.name);
    expect(desc.tags).toEqual([terminator!.tag]);
    expect(desc.description).toBe(terminator!.description);
    expect(desc.delivery).toBe(true);
    // Terminator tools are always frontend-scoped to a bot (not
    // terminal), so requiresAmbientChat = true.
    expect(desc.requiresAmbientChat).toBe(true);
  });

  it("delivery defaults to false when endsTurn is omitted", () => {
    const nonTerm = ALL_TOOLS.find((t) => !t.endsTurn);
    expect(nonTerm).toBeDefined();
    expect(toolDefinitionToDescriptor(nonTerm!).delivery).toBe(false);
  });

  it("marks history/members/media/web tools as readOnly", () => {
    const search = ALL_TOOLS.find((t) => t.tag === "history");
    if (search) {
      const desc = toolDefinitionToDescriptor(search);
      expect(desc.readOnly).toBe(true);
    }
    const web = ALL_TOOLS.find((t) => t.tag === "web");
    if (web) {
      const desc = toolDefinitionToDescriptor(web);
      expect(desc.readOnly).toBe(true);
    }
  });

  it("marks messaging tools as not readOnly", () => {
    const send = ALL_TOOLS.find((t) => t.tag === "messaging");
    if (send) {
      const desc = toolDefinitionToDescriptor(send);
      expect(desc.readOnly).toBe(false);
    }
  });

  it("registers turn-terminator tools with delivery: true", () => {
    const terminators = ALL_TOOLS.filter((t) => t.endsTurn).map((t) => t.name);
    expect(terminators.length).toBeGreaterThan(0);
    const reg = buildToolRegistryFromCatalog();
    for (const name of terminators) {
      const d = reg.get(name);
      expect(d).toBeDefined();
      expect(d!.delivery).toBe(true);
    }
  });

  it("forPolicy(chat) returns the full set (chat has no tool filter)", () => {
    const reg = buildToolRegistryFromCatalog();
    const tools = reg.forPolicy(defaultRunPolicyFor("chat"));
    expect(tools.length).toBe(ALL_TOOLS.length);
  });
});

describe("getGlobalToolRegistry — process-scoped lazy singleton", () => {
  beforeEach(() => {
    resetGlobalToolRegistry();
  });

  it("returns the same instance across calls", () => {
    const a = getGlobalToolRegistry();
    const b = getGlobalToolRegistry();
    expect(a).toBe(b);
  });

  it("is populated from ALL_TOOLS on first access", () => {
    const reg = getGlobalToolRegistry();
    expect(reg.size()).toBe(ALL_TOOLS.length);
  });

  it("reset clears the cache so the next access rebuilds", () => {
    const a = getGlobalToolRegistry();
    resetGlobalToolRegistry();
    const b = getGlobalToolRegistry();
    expect(a).not.toBe(b);
    expect(b.size()).toBe(ALL_TOOLS.length);
  });
});
