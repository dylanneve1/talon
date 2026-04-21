import { describe, it, expect, vi } from "vitest";
import { finalizeTurn } from "../core/response-stream.js";
import type { ResponseStream } from "../core/types.js";

function createFake(init: Partial<{ pending: boolean }> = {}): ResponseStream & {
  committed: string[];
  discarded: number;
} {
  let pending = init.pending ?? false;
  const committed: string[] = [];
  let discarded = 0;
  return {
    committed,
    get discarded() {
      return discarded;
    },
    update(text: string) {
      pending = text.trimEnd().length > 0;
    },
    async commit(text?: string) {
      committed.push(text ?? "<pending>");
      pending = false;
    },
    async discard() {
      discarded += 1;
      pending = false;
    },
    hasPending() {
      return pending;
    },
  } as ResponseStream & { committed: string[]; discarded: number };
}

describe("finalizeTurn", () => {
  it("discards when a send_* tool delivered the answer, even if text is pending", async () => {
    const s = createFake({ pending: true });
    await finalizeTurn(s, { bridgeMessageCount: 2 });
    expect(s.committed).toEqual([]);
    expect(s.discarded).toBe(1);
  });

  it("commits pending text when no tool delivered the answer", async () => {
    const s = createFake({ pending: true });
    await finalizeTurn(s, { bridgeMessageCount: 0 });
    expect(s.committed).toEqual(["<pending>"]);
    expect(s.discarded).toBe(0);
  });

  it("commits explicit undelivered text even when no preview was buffered", async () => {
    const s = createFake({ pending: false });
    await finalizeTurn(s, {
      bridgeMessageCount: 0,
      undeliveredText: "final assistant text",
    });
    expect(s.committed).toEqual(["final assistant text"]);
    expect(s.discarded).toBe(0);
  });

  it("prefers explicit undelivered text over stale preview text", async () => {
    const s = createFake({ pending: true });
    await finalizeTurn(s, {
      bridgeMessageCount: 0,
      undeliveredText: "full final text",
    });
    expect(s.committed).toEqual(["full final text"]);
    expect(s.discarded).toBe(0);
  });

  it("discards when nothing is pending and no tool fired (empty turn)", async () => {
    const s = createFake({ pending: false });
    await finalizeTurn(s, { bridgeMessageCount: 0 });
    expect(s.committed).toEqual([]);
    expect(s.discarded).toBe(1);
  });
});

describe("ResponseStream contract — fake conformance", () => {
  it("update flips hasPending; commit/discard clear it", async () => {
    const s = createFake();
    expect(s.hasPending()).toBe(false);
    s.update("hi");
    expect(s.hasPending()).toBe(true);
    await s.commit();
    expect(s.hasPending()).toBe(false);

    s.update("again");
    await s.discard();
    expect(s.hasPending()).toBe(false);
  });
});

describe("TeamsStream", () => {
  it("buffers update() and posts card on commit; discard drops the buffer", async () => {
    vi.resetModules();
    const postMock = vi.fn(async () => ({ ok: true, text: async () => "" }));
    vi.doMock("../frontend/teams/proxy-fetch.js", () => ({ proxyFetch: postMock }));
    const { createTeamsStream } = await import("../frontend/teams/stream.js");

    const s = createTeamsStream({ webhookUrl: "https://example.invalid/hook" });
    s.update("partial");
    expect(s.hasPending()).toBe(true);
    await s.commit();
    expect(postMock).toHaveBeenCalledTimes(1);

    const s2 = createTeamsStream({ webhookUrl: "https://example.invalid/hook" });
    s2.update("buffered");
    await s2.discard();
    // Only the first stream's commit posted; discard did not.
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalStream", () => {
  it("commit renders assistant message and stops spinner; discard only stops spinner", async () => {
    const { createTerminalStream } = await import(
      "../frontend/terminal/stream.js"
    );
    const renderer = {
      stopSpinner: vi.fn(),
      renderAssistantMessage: vi.fn(),
    };
    const s = createTerminalStream(
      renderer as unknown as Parameters<typeof createTerminalStream>[0],
    );
    s.update("partial");
    await s.commit("final text");
    expect(renderer.renderAssistantMessage).toHaveBeenCalledWith("final text");
    expect(renderer.stopSpinner).toHaveBeenCalled();

    const renderer2 = {
      stopSpinner: vi.fn(),
      renderAssistantMessage: vi.fn(),
    };
    const s2 = createTerminalStream(
      renderer2 as unknown as Parameters<typeof createTerminalStream>[0],
    );
    s2.update("partial");
    await s2.discard();
    expect(renderer2.renderAssistantMessage).not.toHaveBeenCalled();
    expect(renderer2.stopSpinner).toHaveBeenCalled();
  });
});
