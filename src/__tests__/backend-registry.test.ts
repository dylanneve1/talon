/**
 * Tests for the backend registry — register, lookup, listing, clear.
 *
 * Each test calls `clearBackends()` first to isolate from the other
 * tests (and from any factory side-effect-imports that may have run).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  registerBackend,
  getBackend,
  listBackends,
  clearBackends,
  hasBackend,
  type BackendFactory,
} from "../backend/registry.js";
import type { QueryResult } from "../backend/shared/handler-types.js";
import { stubBackend } from "./helpers/stub-backend.js";
import type { BackendId } from "../core/agent-runtime/model-ref.js";

function makeStubFactory(id: string, label = id.toUpperCase()): BackendFactory {
  return {
    id,
    label,
    async init() {
      const backend = stubBackend({
        id: id as BackendId,
        label,
        query: async (): Promise<QueryResult> => ({
          text: `stub:${id}`,
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      });
      return { backend };
    },
  };
}

describe("backend registry", () => {
  beforeEach(() => {
    clearBackends();
  });

  afterEach(() => {
    clearBackends();
  });

  it("registers + retrieves a backend", () => {
    registerBackend(makeStubFactory("stub"));
    const got = getBackend("stub");
    expect(got).toBeDefined();
    expect(got?.id).toBe("stub");
    expect(got?.label).toBe("STUB");
  });

  it("returns undefined for unknown id", () => {
    expect(getBackend("nope")).toBeUndefined();
  });

  it("rejects duplicate registration", () => {
    registerBackend(makeStubFactory("dup"));
    expect(() => registerBackend(makeStubFactory("dup"))).toThrow(
      /already registered/i,
    );
  });

  it("listBackends returns sorted by id", () => {
    registerBackend(makeStubFactory("zeta"));
    registerBackend(makeStubFactory("alpha"));
    registerBackend(makeStubFactory("middle"));
    const list = listBackends();
    expect(list.map((b) => b.id)).toEqual(["alpha", "middle", "zeta"]);
  });

  it("listBackends returns empty array when nothing is registered", () => {
    expect(listBackends()).toEqual([]);
  });

  it("hasBackend works", () => {
    expect(hasBackend("x")).toBe(false);
    registerBackend(makeStubFactory("x"));
    expect(hasBackend("x")).toBe(true);
  });

  it("clearBackends drops everything", () => {
    registerBackend(makeStubFactory("a"));
    registerBackend(makeStubFactory("b"));
    expect(listBackends()).toHaveLength(2);
    clearBackends();
    expect(listBackends()).toHaveLength(0);
  });

  it("init() returns the wired Backend", async () => {
    const factory = makeStubFactory("stub");
    registerBackend(factory);
    const got = getBackend("stub")!;
    const { backend } = await got.init({} as never, {
      getBridgePort: () => 0,
      frontendName: "telegram",
    });
    // The backend's chat slot wraps the underlying query through
    // handlerToEvents — drain the stream to recover the result text.
    expect(backend.chat).toBeDefined();
    const events: import("../core/agent-runtime/events.js").AgentEvent[] = [];
    for await (const event of backend.chat!.runChatTurn({
      chatId: "1",
      model: {
        backend: "stub" as never,
        id: "x",
        displayName: "x",
        source: "discovered" as const,
        cacheSupport: "none" as const,
        selectable: true,
      },
      text: "x",
      senderName: "u",
    })) {
      events.push(event);
    }
    const completed = events.find((e) => e.type === "completed");
    expect(
      completed && completed.type === "completed" && completed.result?.text,
    ).toBe("stub:stub");
  });
});
