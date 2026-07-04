/**
 * Tests for the Phase B memory pre-retrieval boundary: the no-op default
 * retriever and the #373 trust policy (only operator-direct / bot-inferred /
 * heartbeat-synthesized items are ever eligible for automatic injection —
 * user claims and group-chat content stay pull-only).
 */

import { describe, expect, it } from "vitest";
import type { RetrievedMemory } from "../core/agent-runtime/capabilities.js";
import {
  AUTO_INJECT_TRUST_LEVELS,
  filterAutoInjectable,
  isAutoInjectTrusted,
  noopMemoryRetriever,
} from "../core/memory/retrieval.js";

describe("noopMemoryRetriever", () => {
  it("always resolves undefined", async () => {
    await expect(
      noopMemoryRetriever({
        runKind: "chat",
        chatId: "c",
        text: "anything",
        senderName: "Dylan",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("trust policy (#373)", () => {
  it("only the three trusted provenance levels are auto-injectable", () => {
    expect(isAutoInjectTrusted("dylan_direct")).toBe(true);
    expect(isAutoInjectTrusted("bot_inferred")).toBe(true);
    expect(isAutoInjectTrusted("heartbeat_synthesis")).toBe(true);
    expect(isAutoInjectTrusted("user_claim")).toBe(false);
    expect(isAutoInjectTrusted("group_chat")).toBe(false);
  });

  it("absent trust level means untrusted — never auto-inject unknowns", () => {
    expect(isAutoInjectTrusted(undefined)).toBe(false);
  });

  it("the trusted set never silently includes pull-only levels", () => {
    expect(AUTO_INJECT_TRUST_LEVELS.has("user_claim" as never)).toBe(false);
    expect(AUTO_INJECT_TRUST_LEVELS.has("group_chat" as never)).toBe(false);
    expect(AUTO_INJECT_TRUST_LEVELS.size).toBe(3);
  });
});

describe("filterAutoInjectable", () => {
  const base: RetrievedMemory = {
    source: "mempalace",
    query: "q",
    items: [
      { wing: "a", text: "trusted", trustLevel: "dylan_direct" },
      { wing: "b", text: "poisoned claim", trustLevel: "user_claim" },
      { wing: "c", text: "group noise", trustLevel: "group_chat" },
      { wing: "d", text: "no provenance" },
      { wing: "e", text: "synthesized", trustLevel: "heartbeat_synthesis" },
    ],
  };

  it("drops untrusted and unlabelled items, keeps trusted ones", () => {
    const out = filterAutoInjectable(base);
    expect(out?.items.map((i) => i.wing)).toEqual(["a", "e"]);
  });

  it("returns undefined when nothing survives the filter", () => {
    const out = filterAutoInjectable({
      ...base,
      items: base.items.filter((i) => i.trustLevel === "user_claim"),
    });
    expect(out).toBeUndefined();
  });

  it("passes undefined through", () => {
    expect(filterAutoInjectable(undefined)).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const before = base.items.length;
    filterAutoInjectable(base);
    expect(base.items.length).toBe(before);
  });
});
