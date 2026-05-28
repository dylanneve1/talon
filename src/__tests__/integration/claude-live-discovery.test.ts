/**
 * Live Claude Code / Claude Agent SDK integration test.
 *
 * The stub Claude tests drive Talon's full message pipeline without spending
 * tokens. This suite covers the deployment seam the stub cannot represent:
 * a real Claude Code binary launched by the real @anthropic-ai/claude-agent-sdk
 * subprocess bridge, returning live supported-model metadata.
 *
 * Ordinary test runs skip this suite if `claude` is not on PATH. CI installs
 * the Claude Code version paired with the locked SDK and sets
 * CLAUDE_LIVE_REQUIRED=1, so the backend cannot silently skip there.
 */

import { describe, expect, it } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { clearModels, getModels, resolveModelId } from "../../core/models.js";
import { registerClaudeModels } from "../../backend/claude-sdk/models.js";
import { cliAvailable, cliVersion } from "./live-backend-helpers.js";

const CLAUDE_EXECUTABLE_ENV = "CLAUDE_CODE_EXECUTABLE";
const CLAUDE_PRESENT = cliAvailable("claude", CLAUDE_EXECUTABLE_ENV);
const CLAUDE_REQUIRED = process.env.CLAUDE_LIVE_REQUIRED === "1";
const claudeDescribe =
  CLAUDE_PRESENT || CLAUDE_REQUIRED ? describe : describe.skip;
const DISCOVERY_TIMEOUT_MS = 20_000;

type SdkModelInfo = {
  value?: string;
  displayName?: string;
  description?: string;
};

function sdkOptions(abortController?: AbortController) {
  return {
    model: "default",
    ...(process.env[CLAUDE_EXECUTABLE_ENV]
      ? { pathToClaudeCodeExecutable: process.env[CLAUDE_EXECUTABLE_ENV] }
      : {}),
    ...(abortController ? { abortController } : {}),
  } as Parameters<typeof query>[0]["options"];
}

async function* neverPrompt(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

async function discoverSupportedModels(): Promise<SdkModelInfo[]> {
  const abort = new AbortController();
  const q = query({
    prompt: neverPrompt(abort.signal),
    options: sdkOptions(abort),
  });

  const drainPromise = (async () => {
    try {
      for await (const _ of q) {
        /* discard */
      }
    } catch {
      /* expected when the discovery query is aborted */
    }
  })();

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(
          new Error(
            `Claude SDK supportedModels timed out after ${DISCOVERY_TIMEOUT_MS}ms`,
          ),
        ),
      DISCOVERY_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([q.supportedModels(), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    abort.abort();
    await drainPromise;
  }
}

claudeDescribe("Claude SDK live discovery (integration)", () => {
  it("has a real Claude Code CLI available", () => {
    if (!CLAUDE_PRESENT) {
      throw new Error(
        "Claude Code CLI is required for this test but `claude --version` failed. Install @anthropic-ai/claude-code or unset CLAUDE_LIVE_REQUIRED.",
      );
    }

    expect(cliVersion("claude", CLAUDE_EXECUTABLE_ENV)).toMatch(/claude/i);
  });

  it(
    "real SDK supportedModels() returns model metadata",
    async () => {
      const models = await discoverSupportedModels();

      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(typeof model.value).toBe("string");
        expect(model.value?.length).toBeGreaterThan(0);
        expect(typeof model.displayName).toBe("string");
        expect(model.displayName?.length).toBeGreaterThan(0);
      }
    },
    DISCOVERY_TIMEOUT_MS + 5_000,
  );

  // Regression guard: SDK 0.3.153 shipped a binary whose hardcoded model list
  // topped out at opus-4-6 / sonnet-4-6 even though the API was already
  // serving 4.7 and 4.8 — `supportedModels()` returned only
  // `default, sonnet[1m], haiku` and no opus tier at all, so the `/model`
  // picker silently dropped every opus generation. Bumping to 0.3.154+
  // restored opus discovery. This test fails if a future SDK ever regresses
  // again by dropping the opus tier entirely.
  it(
    "real SDK supportedModels() includes at least one opus model",
    async () => {
      const models = await discoverSupportedModels();
      const hasOpus = models.some((m) =>
        (m.value ?? "").toLowerCase().includes("opus"),
      );
      expect(
        hasOpus,
        `Expected an opus model in discovery, got: ${models.map((m) => m.value).join(", ")}`,
      ).toBe(true);
    },
    DISCOVERY_TIMEOUT_MS + 5_000,
  );

  it(
    "registerClaudeModels consumes live SDK metadata",
    async () => {
      clearModels();

      await registerClaudeModels({
        model: "default",
        ...(process.env[CLAUDE_EXECUTABLE_ENV]
          ? { pathToClaudeCodeExecutable: process.env[CLAUDE_EXECUTABLE_ENV] }
          : {}),
      });

      const models = getModels("anthropic");
      expect(models.length).toBeGreaterThan(0);
      expect(resolveModelId(models[0]!.id)).toBe(models[0]!.id);
    },
    DISCOVERY_TIMEOUT_MS + 5_000,
  );
});
