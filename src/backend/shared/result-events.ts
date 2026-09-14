/**
 * The `usage` + `completed` pair that closes every successful
 * `runChatTurn` stream, whether the backend emits events natively
 * (Claude SDK) or through `handlerToEvents`. Kept free of storage and
 * logging imports so the adapter stays a pure event translator.
 */

import type { AgentEvent } from "../../core/agent-runtime/events.js";
import type { TokenUsageSnapshot } from "./usage.js";

export function buildResultEvents(inputs: {
  text: string;
  durationMs: number;
  usage: TokenUsageSnapshot;
  modelId: string;
}): [AgentEvent, AgentEvent] {
  const usage = { ...inputs.usage, modelId: inputs.modelId };
  return [
    { type: "usage", usage },
    {
      type: "completed",
      result: {
        text: inputs.text,
        durationMs: inputs.durationMs,
        usage,
        modelId: inputs.modelId,
      },
    },
  ];
}
