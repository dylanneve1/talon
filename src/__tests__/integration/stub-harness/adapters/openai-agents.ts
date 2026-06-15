/**
 * openai-agents stub adapter — points the backend's `@openai/agents` SDK at a
 * fake OpenAI-compatible server. Setting `TALON_AGENTS_URL` makes Talon default
 * the SDK to `chat_completions` mode (standard OpenAI streaming), which the
 * fake server speaks.
 */
import type { TalonConfig } from "../../../../util/config.js";
import type { StubBackendAdapter } from "../types.js";
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
  type OpenAITurn,
} from "../../stub-openai/fake-openai-server.js";

export function openaiAgentsAdapter(
  model = "stub-model",
): StubBackendAdapter<OpenAITurn> {
  let server: FakeOpenAIServer | null = null;

  return {
    id: "openai-agents" as TalonConfig["backend"],
    model,

    async prepare() {
      server = await startFakeOpenAIServer(model);
      // The OpenAI client appends `/chat/completions` + `/models` to the base
      // URL; mirror OpenAI's `/v1` convention. Force chat_completions mode.
      process.env.TALON_AGENTS_URL = `http://127.0.0.1:${server.port}/v1`;
      process.env.TALON_AGENTS_KEY = "stub-openai-key";
      process.env.TALON_AGENTS_API_MODE = "chat_completions";
    },

    applyTurn(turn) {
      if (!server) throw new Error("openai adapter: server not started");
      server.setTurn(turn);
    },

    async teardown() {
      await server?.stop();
      server = null;
      delete process.env.TALON_AGENTS_URL;
      delete process.env.TALON_AGENTS_KEY;
      delete process.env.TALON_AGENTS_API_MODE;
    },
  };
}
