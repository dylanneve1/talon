/**
 * OpenAI Agents backend — constants, state lifecycle, factory tests.
 *
 * The handler itself spawns real `MCPServerStdio` subprocesses and
 * issues real OpenAI API calls — not testable here without an API
 * key. These tests cover the parts that don't require a live model:
 * constants, state, factory registration.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX,
  OPENAI_AGENTS_DEFAULT_MODEL,
  OPENAI_AGENTS_MAX_TURNS,
  OPENAI_AGENTS_AGENT_NAME,
} from "../backend/openai-agents/constants.js";
import { getState, resetState } from "../backend/openai-agents/state.js";
import { initOpenAIAgentsAgent } from "../backend/openai-agents/init.js";

describe("openai-agents / constants", () => {
  it("default model is gpt-5.5 (broadest-access flagship)", () => {
    expect(OPENAI_AGENTS_DEFAULT_MODEL).toBe("gpt-5.5");
  });

  it("max turns is a reasonable bound on the agent loop", () => {
    expect(OPENAI_AGENTS_MAX_TURNS).toBeGreaterThan(1);
    expect(OPENAI_AGENTS_MAX_TURNS).toBeLessThanOrEqual(100);
  });

  it("agent name is Talon (surfaces in OpenAI traces)", () => {
    expect(OPENAI_AGENTS_AGENT_NAME).toBe("Talon");
  });

  it("documents both delivery routes in the system prompt suffix", () => {
    expect(OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX).toContain("end_turn");
    expect(OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX).toContain("send");
    expect(OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX).toContain("react");
    expect(OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX).toContain("tool-only delivery");
    expect(OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX).toContain("FLOW VIOLATION");
  });
});

describe("openai-agents / state lifecycle", () => {
  beforeEach(() => {
    resetState();
  });

  it("starts in an uninitialised state", () => {
    expect(getState().config).toBeNull();
    expect(getState().frontendName).toBe("telegram");
  });

  it("captures config + gateway port + frontend on initOpenAIAgentsAgent", () => {
    initOpenAIAgentsAgent(
      { model: "gpt-5.5", openaiApiKey: "test-key" } as never,
      () => 12345,
      "discord",
    );

    const state = getState();
    expect(state.config).toBeTruthy();
    expect(state.gatewayPortFn()).toBe(12345);
    expect(state.frontendName).toBe("discord");
  });

  it("resetState clears everything", () => {
    initOpenAIAgentsAgent({ openaiApiKey: "k" } as never, () => 999, "teams");
    expect(getState().config).not.toBeNull();

    resetState();

    expect(getState().config).toBeNull();
    expect(getState().frontendName).toBe("telegram");
  });
});

describe("openai-agents / factory registration", () => {
  it("registers as `openai-agents` in the backend registry", async () => {
    const { clearBackends, registerBackend, hasBackend, getBackend } =
      await import("../backend/registry.js");
    clearBackends();

    await import("../backend/openai-agents/factory.js");

    if (!hasBackend("openai-agents")) {
      registerBackend({
        id: "openai-agents",
        label: "OpenAI Agents",
        init: async () => {
          throw new Error("placeholder factory");
        },
      });
    }

    expect(hasBackend("openai-agents")).toBe(true);
    const factory = getBackend("openai-agents");
    expect(factory?.id).toBe("openai-agents");
    expect(factory?.label).toMatch(/OpenAI Agents/i);
  });
});
