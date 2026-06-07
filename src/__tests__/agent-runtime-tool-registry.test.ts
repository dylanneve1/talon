/**
 * Phase 5 prep tests — `ToolRegistry` storage + filter primitive.
 *
 * Pins the invariants Phase 5.x backend renderers will depend on:
 *
 *   - duplicate-id rejection at register-time
 *   - atomic batch register-all rollback on collision
 *   - deterministic list ordering
 *   - `forPolicy` honours the policy's `ToolFilter`
 *   - server grouping is sorted + deterministic
 *   - MCP id parsing for `mcp__<server>__<name>` shape
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ToolRegistry,
  ToolRegistryError,
  groupToolsByServer,
  parseMcpToolId,
} from "../core/agent-runtime/tool-registry.js";
import type { ToolDescriptor } from "../core/agent-runtime/tool-descriptor.js";
import { defaultRunPolicyFor } from "../core/agent-runtime/run-policy.js";

function descriptor(
  id: string,
  overrides: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    id,
    name: id.split("__").at(-1) ?? id,
    tags: [],
    ...overrides,
  };
}

let registry: ToolRegistry;

beforeEach(() => {
  registry = new ToolRegistry();
});

// ── register / has / size / get ─────────────────────────────────────────────

describe("ToolRegistry / register", () => {
  it("stores a tool by id", () => {
    registry.register(descriptor("Bash", { tags: ["shell"] }));
    expect(registry.size()).toBe(1);
    expect(registry.has("Bash")).toBe(true);
    expect(registry.get("Bash")).toMatchObject({ id: "Bash", tags: ["shell"] });
  });

  it("throws on duplicate registration", () => {
    registry.register(descriptor("Bash"));
    expect(() => registry.register(descriptor("Bash"))).toThrow(
      ToolRegistryError,
    );
  });

  it("returns a fresh copy from get — caller mutation does not leak", () => {
    registry.register(descriptor("Bash", { tags: ["shell"] }));
    const got = registry.get("Bash")!;
    got.tags.push("mutated");
    expect(registry.get("Bash")!.tags).toEqual(["shell"]);
  });

  it("get returns undefined for unknown id", () => {
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("size + has stay accurate after unregister", () => {
    registry.register(descriptor("A"));
    registry.register(descriptor("B"));
    expect(registry.size()).toBe(2);
    expect(registry.unregister("A")).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.has("A")).toBe(false);
    expect(registry.unregister("not-there")).toBe(false);
  });
});

// ── registerAll atomicity ───────────────────────────────────────────────────

describe("ToolRegistry / registerAll", () => {
  it("registers every descriptor in one call", () => {
    registry.registerAll([descriptor("A"), descriptor("B"), descriptor("C")]);
    expect(registry.size()).toBe(3);
  });

  it("rolls back on duplicate within the batch", () => {
    expect(() =>
      registry.registerAll([descriptor("A"), descriptor("B"), descriptor("A")]),
    ).toThrow(ToolRegistryError);
    expect(registry.size()).toBe(0);
  });

  it("rolls back on collision with existing registry contents", () => {
    registry.register(descriptor("A"));
    expect(() =>
      registry.registerAll([descriptor("B"), descriptor("A")]),
    ).toThrow(ToolRegistryError);
    // "B" must NOT have been registered — the batch is atomic.
    expect(registry.size()).toBe(1);
    expect(registry.has("B")).toBe(false);
  });
});

// ── list / forPolicy ────────────────────────────────────────────────────────

describe("ToolRegistry / list + forPolicy", () => {
  it("list returns descriptors sorted by id", () => {
    registry.register(descriptor("Bash", { tags: ["shell"] }));
    registry.register(descriptor("Apple", { tags: ["fruit"] }));
    registry.register(descriptor("Cat", { tags: ["animal"] }));
    expect(registry.list().map((t) => t.id)).toEqual(["Apple", "Bash", "Cat"]);
  });

  it("forPolicy returns the unfiltered list when policy has no filter", () => {
    registry.register(descriptor("A"));
    registry.register(descriptor("B"));
    const policy = defaultRunPolicyFor("chat");
    expect(registry.forPolicy(policy).map((t) => t.id)).toEqual(["A", "B"]);
  });

  it("forPolicy applies the policy's tool filter (dream excludes delivery)", () => {
    registry.register(
      descriptor("send", {
        tags: ["messaging"],
        delivery: true,
        requiresAmbientChat: true,
      }),
    );
    registry.register(
      descriptor("end_turn", {
        tags: ["messaging"],
        delivery: true,
        requiresAmbientChat: true,
      }),
    );
    registry.register(
      descriptor("mempalace_search", { tags: ["memory"], readOnly: true }),
    );
    const policy = defaultRunPolicyFor("dream");
    const filtered = registry.forPolicy(policy);
    expect(filtered.map((t) => t.id)).toEqual(["mempalace_search"]);
  });
});

// ── parseMcpToolId / groupToolsByServer ─────────────────────────────────────

describe("ToolRegistry helpers", () => {
  it("parseMcpToolId extracts server + name from MCP id", () => {
    expect(parseMcpToolId("mcp__telegram-tools__end_turn")).toEqual({
      server: "telegram-tools",
      name: "end_turn",
    });
    expect(parseMcpToolId("mcp__brave-search__brave_web_search")).toEqual({
      server: "brave-search",
      name: "brave_web_search",
    });
  });

  it("parseMcpToolId returns null for non-MCP ids", () => {
    expect(parseMcpToolId("Bash")).toBeNull();
    expect(parseMcpToolId("")).toBeNull();
    expect(parseMcpToolId("mcp_no_double_underscore")).toBeNull();
  });

  it("groupToolsByServer groups by server and sorts deterministically", () => {
    const tools: ToolDescriptor[] = [
      {
        id: "mcp__telegram-tools__end_turn",
        server: "telegram-tools",
        name: "end_turn",
        tags: [],
      },
      {
        id: "mcp__telegram-tools__react",
        server: "telegram-tools",
        name: "react",
        tags: [],
      },
      {
        id: "mcp__mempalace-tools__mempalace_search",
        server: "mempalace-tools",
        name: "mempalace_search",
        tags: [],
      },
      {
        id: "Bash",
        name: "Bash",
        tags: [],
      },
    ];
    const grouped = groupToolsByServer(tools);
    expect([...grouped.keys()]).toEqual([
      "builtin",
      "mempalace-tools",
      "telegram-tools",
    ]);
    expect(grouped.get("telegram-tools")!.map((t) => t.name)).toEqual([
      "end_turn",
      "react",
    ]);
    expect(grouped.get("builtin")!.map((t) => t.name)).toEqual(["Bash"]);
  });
});
