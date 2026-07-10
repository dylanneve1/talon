/**
 * Backend conformance tests — verify Kilo and OpenCode produce identical
 * observable behaviour through the shared infrastructure.
 *
 * Why this exists:
 *
 *   The Kilo and OpenCode backends both wrap forks of the same upstream
 *   HTTP API. Their MCP registration, session lifecycle, SSE event
 *   processing, and delivery routing all live in shared modules
 *   (`backend/remote-server/` and `backend/shared/`). Conformance tests
 *   prove that the wiring at each backend's edge — its configurator,
 *   its `extractPartsSummary`, its delivery suffix — composes with the
 *   shared modules to produce the same end state.
 *
 *   These are NOT integration tests against a real upstream server
 *   (see `integration/{kilo,opencode}-real-bootstrap.test.ts` for that).
 *   They drive the shared processors with hand-built event sequences
 *   and assert state-mutation parity between the two backends.
 *
 * Coverage:
 *
 *   1. `processStreamEvent` produces identical state mutations for both
 *      backends given the same event sequence.
 *   2. `finalizePartsIntoState` extracts the same text and tool calls
 *      regardless of which backend's `extractPartsSummary` is plugged
 *      in.
 *   3. `routeDelivery` returns the same route shape for both backends
 *      given equivalent state.
 *   4. The chat MCP visibility rotation behaves identically for both
 *      backends' state containers.
 */

import { describe, it, expect } from "vitest";

import {
  processStreamEvent,
  finalizePartsIntoState,
} from "../backend/remote-server/events.js";
import {
  createRemoteServerState,
  ensureChatMcpServer,
  getRegisteredMcpServerNames,
  type RemoteAgentClient,
} from "../backend/remote-server/index.js";
import { routeDelivery, createStreamState } from "../backend/shared/index.js";
import { extractPartsSummary as kiloExtract } from "../backend/kilo/sessions.js";
import { extractPartsSummary as opencodeExtract } from "../backend/opencode/sessions.js";

// ── Test doubles ────────────────────────────────────────────────────────────

function makeMockClient(): RemoteAgentClient {
  return {
    mcp: {
      add: async () => ({ ok: true }),
      disconnect: async () => ({ ok: true }),
    },
    session: {
      create: async () => ({ data: { id: "sess-1" } }),
      get: async () => ({ ok: true }),
    },
    tool: { ids: async () => ({ data: [] }) },
    provider: { list: async () => ({ data: {} }) },
  };
}

// Representative event sequence for a "model says hi, calls a tool, then
// closes the turn" turn. Mirrors what a real upstream emits.
function makeRepresentativeEventSequence(sessionId: string): Array<{
  type: string;
  properties: Record<string, unknown>;
}> {
  return [
    // 1. Text part is created (registers partID → "text" in state)
    {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: { id: "part-1", type: "text" },
      },
    },
    // 2. Text deltas — accumulate into responseText
    {
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        partID: "part-1",
        field: "text",
        delta: "Hello",
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        partID: "part-1",
        field: "text",
        delta: " world",
      },
    },
    // 3. Reasoning part — accumulates as thinking (not exposed to user)
    {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: { id: "part-2", type: "reasoning" },
      },
    },
    {
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        partID: "part-2",
        field: "text",
        delta: "(thinking privately)",
      },
    },
    // 4. Tool call — recorded with delivered-text capture
    {
      type: "message.part.updated",
      properties: {
        sessionID: sessionId,
        part: {
          id: "part-3",
          type: "tool",
          callID: "call-1",
          tool: "send",
          state: {
            status: "running",
            input: { type: "text", text: "tool-delivered text" },
          },
        },
      },
    },
    // 5. Turn closes
    {
      type: "session.turn.close",
      properties: { sessionID: sessionId },
    },
  ];
}

// ── Conformance: SSE event processing ───────────────────────────────────────

describe("backend conformance — shared SSE event processor", () => {
  it("processes identical event sequences for both backend labels", async () => {
    const sessionId = "sess-conformance";
    const events = makeRepresentativeEventSequence(sessionId);

    const kiloState = createStreamState();
    const opencodeState = createStreamState();
    const seenKilo = new Set<string>();
    const seenOpenCode = new Set<string>();

    for (const event of events) {
      await processStreamEvent(event, {
        chatId: "test-chat",
        sessionId,
        state: kiloState,
        seenToolCallIds: seenKilo,
        backendLabel: "Kilo",
      });
      await processStreamEvent(event, {
        chatId: "test-chat",
        sessionId,
        state: opencodeState,
        seenToolCallIds: seenOpenCode,
        backendLabel: "OpenCode",
      });
    }

    // Both backends must have:
    expect(kiloState.allResponseText).toBe(opencodeState.allResponseText);
    expect(kiloState.currentBlockText).toBe(opencodeState.currentBlockText);
    expect(kiloState.toolCalls).toBe(opencodeState.toolCalls);
    expect(kiloState.turnTerminated).toBe(opencodeState.turnTerminated);
    expect(kiloState.deliveredTextNorms).toEqual(
      opencodeState.deliveredTextNorms,
    );

    // Spot-checks on the absolute state
    expect(kiloState.allResponseText).toContain("Hello world");
    expect(kiloState.allResponseText).not.toContain("thinking privately");
    expect(kiloState.toolCalls).toBe(1);
  });

  it("scope-filters out-of-session events identically", async () => {
    const ourSession = "us";
    const otherSession = "them";

    const kiloState = createStreamState();
    const opencodeState = createStreamState();

    const event = {
      type: "message.part.delta",
      properties: {
        sessionID: otherSession,
        partID: "x",
        field: "text",
        delta: "leak",
      },
    };

    const kiloOutcome = await processStreamEvent(event, {
      chatId: "test-chat",
      sessionId: ourSession,
      state: kiloState,
      seenToolCallIds: new Set(),
      backendLabel: "Kilo",
    });
    const opencodeOutcome = await processStreamEvent(event, {
      chatId: "test-chat",
      sessionId: ourSession,
      state: opencodeState,
      seenToolCallIds: new Set(),
      backendLabel: "OpenCode",
    });

    expect(kiloOutcome).toEqual(opencodeOutcome);
    expect(kiloOutcome.kind).toBe("stop");
    expect(kiloState.allResponseText).toBe("");
    expect(opencodeState.allResponseText).toBe("");
  });

  it("counts events per type symmetrically across backends", async () => {
    const sessionId = "evt-counts";
    const events = [
      {
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          partID: "p",
          field: "text",
          delta: "x",
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: sessionId,
          partID: "p",
          field: "text",
          delta: "y",
        },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: sessionId, part: { id: "p", type: "text" } },
      },
    ];

    const kiloState = createStreamState();
    const opencodeState = createStreamState();

    for (const event of events) {
      await processStreamEvent(event, {
        chatId: "test-chat",
        sessionId,
        state: kiloState,
        seenToolCallIds: new Set(),
        backendLabel: "Kilo",
      });
      await processStreamEvent(event, {
        chatId: "test-chat",
        sessionId,
        state: opencodeState,
        seenToolCallIds: new Set(),
        backendLabel: "OpenCode",
      });
    }

    expect(kiloState.eventCounts).toEqual(opencodeState.eventCounts);
    expect(kiloState.eventCounts).toEqual({
      "message.part.delta": 2,
      "message.part.updated": 1,
    });
  });
});

// ── Conformance: parts finalisation ────────────────────────────────────────

describe("backend conformance — finalizePartsIntoState", () => {
  it("extracts identical text + tools through each backend's extractor", () => {
    const parts = [
      { type: "text", text: "Hello from the model." },
      {
        type: "tool",
        callID: "call-1",
        tool: "send",
        state: { status: "completed", input: { type: "text", text: "ok" } },
      },
      { type: "reasoning", text: "(private)" },
    ];

    const kiloState = createStreamState();
    const opencodeState = createStreamState();

    const kiloResult = finalizePartsIntoState({
      parts,
      state: kiloState,
      seenToolCallIds: new Set(),
      extractPartsSummary: kiloExtract,
    });

    const opencodeResult = finalizePartsIntoState({
      parts,
      state: opencodeState,
      seenToolCallIds: new Set(),
      extractPartsSummary: opencodeExtract,
    });

    expect(kiloResult.toolsProcessed).toBe(opencodeResult.toolsProcessed);
    expect(kiloState.allResponseText).toBe(opencodeState.allResponseText);
    expect(kiloState.allResponseText).toBe("Hello from the model.");
    expect(kiloState.toolCalls).toBe(opencodeState.toolCalls);
  });

  it("both backends now catch synthetic-error parts via the shared extractor", () => {
    // Previous behaviour: only the kilo extractor recognised
    // `synthetic: true`; opencode shipped it as a real reply. Once both
    // backends route their `extractPartsSummary` through the shared
    // `remote-server/session-helpers.ts`, the synthetic-detection is
    // symmetric — both surface the marker through `syntheticErrorText`.
    const parts = [{ type: "text", text: "model output", synthetic: true }];

    const kiloState = createStreamState();
    const opencodeState = createStreamState();

    const kiloResult = finalizePartsIntoState({
      parts,
      state: kiloState,
      seenToolCallIds: new Set(),
      extractPartsSummary: kiloExtract,
    });

    const opencodeResult = finalizePartsIntoState({
      parts,
      state: opencodeState,
      seenToolCallIds: new Set(),
      extractPartsSummary: opencodeExtract,
    });

    expect(kiloResult.syntheticErrorText).toBe("model output");
    expect(kiloState.syntheticError).toBe("model output");
    expect(kiloState.allResponseText).toBe("");

    expect(opencodeResult.syntheticErrorText).toBe("model output");
    expect(opencodeState.syntheticError).toBe("model output");
    expect(opencodeState.allResponseText).toBe("");
  });
});

// ── Conformance: delivery routing ──────────────────────────────────────────

describe("backend conformance — routeDelivery", () => {
  it("returns the same route for all three remote-server backends given equivalent state", async () => {
    // Text-part route — Kilo / OpenCode / Codex all use shared routeDelivery
    const stateA = createStreamState();
    const stateB = createStreamState();
    const stateC = createStreamState();
    const kiloDecision = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "c",
      state: stateA,
      responseText: "Hello",
    });
    const opencodeDecision = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c",
      state: stateB,
      responseText: "Hello",
    });
    const codexDecision = await routeDelivery({
      backendLabel: "Codex",
      chatId: "c",
      state: stateC,
      responseText: "Hello",
    });
    expect(kiloDecision.route).toBe(opencodeDecision.route);
    expect(kiloDecision.route).toBe(codexDecision.route);
    expect(kiloDecision.chars).toBe(opencodeDecision.chars);
    expect(kiloDecision.chars).toBe(codexDecision.chars);

    // Tool route
    const toolStateA = createStreamState();
    Object.assign(toolStateA, { deliveredTextNorms: ["delivered"] });
    const toolStateB = createStreamState();
    Object.assign(toolStateB, { deliveredTextNorms: ["delivered"] });
    const toolStateC = createStreamState();
    Object.assign(toolStateC, { deliveredTextNorms: ["delivered"] });
    const kT = await routeDelivery({
      backendLabel: "Kilo",
      chatId: "c",
      state: toolStateA,
      responseText: "ignored",
    });
    const oT = await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c",
      state: toolStateB,
      responseText: "ignored",
    });
    const cT = await routeDelivery({
      backendLabel: "Codex",
      chatId: "c",
      state: toolStateC,
      responseText: "ignored",
    });
    expect(kT.route).toBe(oT.route);
    expect(kT.route).toBe(cT.route);
    expect(kT.route).toBe("tool");
  });

  it("uses backend label in synthetic-error message prefix (all three remote-server backends)", async () => {
    const kiloMessages: string[] = [];
    const opencodeMessages: string[] = [];
    const codexMessages: string[] = [];

    const stateA = createStreamState();
    Object.assign(stateA, { syntheticError: "boom" });
    const stateB = createStreamState();
    Object.assign(stateB, { syntheticError: "boom" });
    const stateC = createStreamState();
    Object.assign(stateC, { syntheticError: "boom" });

    await routeDelivery({
      backendLabel: "Kilo",
      chatId: "c",
      state: stateA,
      responseText: "",
      onTextBlock: async (text) => {
        kiloMessages.push(text);
      },
    });

    await routeDelivery({
      backendLabel: "OpenCode",
      chatId: "c",
      state: stateB,
      responseText: "",
      onTextBlock: async (text) => {
        opencodeMessages.push(text);
      },
    });

    await routeDelivery({
      backendLabel: "Codex",
      chatId: "c",
      state: stateC,
      responseText: "",
      onTextBlock: async (text) => {
        codexMessages.push(text);
      },
    });

    expect(kiloMessages[0]).toBe("⚠️ Kilo: boom");
    expect(opencodeMessages[0]).toBe("⚠️ OpenCode: boom");
    expect(codexMessages[0]).toBe("⚠️ Codex: boom");
  });
});

// ── Conformance: MCP visibility rotation ───────────────────────────────────

describe("backend conformance — MCP chat-server rotation", () => {
  it("rotates chat MCP servers identically for both backend states", async () => {
    const kiloState = createRemoteServerState<RemoteAgentClient>({
      label: "Kilo",
      hostname: "127.0.0.1",
      port: 9001,
    });
    const opencodeState = createRemoteServerState<RemoteAgentClient>({
      label: "OpenCode",
      hostname: "127.0.0.1",
      port: 9002,
    });

    // Register chat A on both
    await ensureChatMcpServer(makeMockClient(), kiloState, "chatA");
    await ensureChatMcpServer(makeMockClient(), opencodeState, "chatA");

    expect(getRegisteredMcpServerNames(kiloState)).toEqual(
      getRegisteredMcpServerNames(opencodeState),
    );

    // Switch to chat B — both should rotate out chat A
    await ensureChatMcpServer(makeMockClient(), kiloState, "chatB");
    await ensureChatMcpServer(makeMockClient(), opencodeState, "chatB");

    const kiloNames = getRegisteredMcpServerNames(kiloState).sort();
    const opencodeNames = getRegisteredMcpServerNames(opencodeState).sort();
    expect(kiloNames).toEqual(opencodeNames);
    expect(kiloNames).toEqual(["talon-tools-chatB"]);
  });

  it("preserves heartbeat sentinel for both backends symmetrically", async () => {
    const kiloState = createRemoteServerState<RemoteAgentClient>({
      label: "Kilo",
      hostname: "127.0.0.1",
      port: 9003,
    });
    const opencodeState = createRemoteServerState<RemoteAgentClient>({
      label: "OpenCode",
      hostname: "127.0.0.1",
      port: 9004,
    });

    // Seed heartbeat sentinel + a chat server in both
    kiloState.registeredMcpServers.add("talon-tools-heartbeat");
    kiloState.registeredMcpServers.add("talon-tools-chatA");
    opencodeState.registeredMcpServers.add("talon-tools-heartbeat");
    opencodeState.registeredMcpServers.add("talon-tools-chatA");

    // Switch to chat B
    await ensureChatMcpServer(makeMockClient(), kiloState, "chatB");
    await ensureChatMcpServer(makeMockClient(), opencodeState, "chatB");

    const kiloNames = getRegisteredMcpServerNames(kiloState).sort();
    const opencodeNames = getRegisteredMcpServerNames(opencodeState).sort();

    expect(kiloNames).toEqual(opencodeNames);
    expect(kiloNames).toContain("talon-tools-heartbeat");
    expect(kiloNames).toContain("talon-tools-chatB");
    expect(kiloNames).not.toContain("talon-tools-chatA");
  });
});
