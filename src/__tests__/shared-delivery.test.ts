/**
 * Unit tests for the unified delivery router (`backend/shared/delivery.ts`).
 *
 * Both the Kilo and OpenCode handlers route their end-of-turn delivery
 * through `routeDelivery`. The four routes (tool / synthetic-error /
 * text-part / empty) are asserted here against a hand-built
 * `StreamState` — the integration tests in `integration/*` cover the
 * end-to-end paths through a real upstream server.
 */

import { describe, it, expect, vi } from "vitest";

import {
  routeDelivery,
  createStreamState,
  TextBlockDeliveryError,
  type StreamState,
} from "../backend/shared/index.js";

function makeState(overrides: Partial<StreamState> = {}): StreamState {
  const state = createStreamState();
  Object.assign(state, overrides);
  return state;
}

describe("shared / routeDelivery", () => {
  it("route=tool when a bridge-delivering tool captured text norms", async () => {
    const state = makeState({ deliveredTextNorms: ["hello world"] });
    const onTextBlock = vi.fn();

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "ignored because tool already delivered",
      onTextBlock,
    });

    expect(decision.route).toBe("tool");
    expect(decision.chars).toBe("hello world".length);
    // Bridge-delivery already happened, we don't double-send
    expect(onTextBlock).not.toHaveBeenCalled();
  });

  it("route=tool when hadBridgeDelivery is set without text norms (e.g. send photo)", async () => {
    const state = makeState({ hadBridgeDelivery: true });
    const onTextBlock = vi.fn();

    const decision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "chat-1",
      state,
      responseText: "model chain-of-thought ramble",
      onTextBlock,
    });

    expect(decision.route).toBe("tool");
    expect(decision.chars).toBe(0);
    expect(onTextBlock).not.toHaveBeenCalled();
  });

  it("route=synthetic-error emits a ⚠️-prefixed message with backend label", async () => {
    const state = makeState({
      syntheticError: "model hit its output limit while reasoning",
    });
    const onTextBlock = vi.fn().mockResolvedValue(undefined);

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "",
      onTextBlock,
    });

    expect(decision.route).toBe("synthetic-error");
    expect(decision.chars).toBe(state.syntheticError?.length);
    expect(onTextBlock).toHaveBeenCalledWith(
      "⚠️ Kilo: model hit its output limit while reasoning",
    );
  });

  it("route=text-part emits the response text", async () => {
    const state = makeState();
    const onTextBlock = vi.fn().mockResolvedValue(undefined);

    const decision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "chat-1",
      state,
      responseText: "Hello! Here is your reply.",
      onTextBlock,
    });

    expect(decision.route).toBe("text-part");
    expect(decision.chars).toBe("Hello! Here is your reply.".length);
    expect(onTextBlock).toHaveBeenCalledWith("Hello! Here is your reply.");
  });

  it("route=empty for a turn that produced no text, no tools, no delivery", async () => {
    const state = makeState();
    const onTextBlock = vi.fn().mockResolvedValue(undefined);

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "",
      onTextBlock,
    });

    expect(decision.route).toBe("empty");
    expect(decision.chars).toBe(0);
    expect(onTextBlock).toHaveBeenCalledTimes(1);
    expect(onTextBlock.mock.calls[0][0]).toContain("no reply");
  });

  it("route=empty distinguishes tool-call-loop from no-output", async () => {
    const stateA = makeState({ toolCalls: 0 });
    const onTextBlockA = vi.fn().mockResolvedValue(undefined);
    await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state: stateA,
      responseText: "",
      onTextBlock: onTextBlockA,
    });
    expect(onTextBlockA.mock.calls[0][0]).toBe(
      "(no reply — model returned no output)",
    );

    const stateB = makeState({ toolCalls: 3 });
    const onTextBlockB = vi.fn().mockResolvedValue(undefined);
    await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state: stateB,
      responseText: "",
      onTextBlock: onTextBlockB,
    });
    expect(onTextBlockB.mock.calls[0][0]).toBe(
      "(no reply — model called tools but didn't produce output text)",
    );
  });

  it("route=tool with 0 chars for a terminated silent turn", async () => {
    // `end_turn()` with no text — the model legitimately ended silently.
    const state = makeState({ turnTerminated: true });
    const onTextBlock = vi.fn();

    const decision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "chat-1",
      state,
      responseText: "",
      onTextBlock,
    });

    expect(decision.route).toBe("tool");
    expect(decision.chars).toBe(0);
    expect(onTextBlock).not.toHaveBeenCalled();
  });

  it("synthetic-error preferred over plain text when responseText is empty", async () => {
    const state = makeState({ syntheticError: "rate limited" });
    const onTextBlock = vi.fn().mockResolvedValue(undefined);

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "",
      onTextBlock,
    });

    expect(decision.route).toBe("synthetic-error");
    expect(onTextBlock).toHaveBeenCalledWith("⚠️ Kilo: rate limited");
  });

  it("text-part preferred over synthetic-error when responseText is non-empty", async () => {
    const state = makeState({ syntheticError: "soft warning" });
    const onTextBlock = vi.fn().mockResolvedValue(undefined);

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "Real reply",
      onTextBlock,
    });

    expect(decision.route).toBe("text-part");
    expect(onTextBlock).toHaveBeenCalledWith("Real reply");
  });

  it("does not throw when onTextBlock itself throws (non-fatal)", async () => {
    const state = makeState();
    const onTextBlock = vi.fn().mockRejectedValue(new Error("network down"));

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "would-be reply",
      onTextBlock,
    });

    expect(decision.route).toBe("text-part");
    expect(decision.chars).toBe("would-be reply".length);
  });

  it("throws on onTextBlock failure when propagation is enabled", async () => {
    const state = makeState();
    const onTextBlock = vi
      .fn()
      .mockRejectedValue(new Error("message is too long"));

    await expect(
      routeDelivery({
        backendLabel: "Codex",
        chatId: "chat-1",
        state,
        responseText: "would-be reply",
        onTextBlock,
        propagateDeliveryFailure: true,
      }),
    ).rejects.toMatchObject({
      route: "text-part",
      chars: "would-be reply".length,
    });
    await expect(
      routeDelivery({
        backendLabel: "Codex",
        chatId: "chat-1",
        state,
        responseText: "would-be reply",
        onTextBlock,
        propagateDeliveryFailure: true,
      }),
    ).rejects.toBeInstanceOf(TextBlockDeliveryError);
  });

  it("works without onTextBlock callback (decision-only path)", async () => {
    const state = makeState();

    const decision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "reply",
    });

    expect(decision.route).toBe("text-part");
    expect(decision.chars).toBe(5);
  });

  it("metricNamespace defaults to lowercased backendLabel", async () => {
    // Indirect check: with backendLabel "Kilo" the synthetic-error
    // route increments `kilo.synthetic_error`. We can't read the
    // counter from here directly, but we can verify the decision shape
    // doesn't change when an explicit namespace is provided.
    const state = makeState({ syntheticError: "boom" });
    const explicit = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state,
      responseText: "",
      metricNamespace: "custom-namespace",
    });
    const defaulted = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "chat-1",
      state: makeState({ syntheticError: "boom" }),
      responseText: "",
    });
    expect(explicit.route).toBe("synthetic-error");
    expect(defaulted.route).toBe("synthetic-error");
  });
});
