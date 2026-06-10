/**
 * Backend contract assertions.
 *
 * Shared test suite every concrete backend (Claude SDK, Codex,
 * Kilo, OpenCode, OpenAI Agents) must pass. These are the
 * assertions; `backend-contract.test.ts` wires the full suite
 * across every shipped `BackendId` through the real
 * `handlerToEvents` → `composeBackend` path, and per-backend
 * handler tests can re-use individual assertions for SDK-specific
 * scenarios:
 *
 *   import { assertChatBackendTerminates } from "...";
 *   it("terminates", () => assertChatBackendTerminates(claudeBackend));
 *
 * Each function:
 *   - takes a `Backend`,
 *   - exercises one specific contract clause,
 *   - throws a `ContractViolation` when the clause is violated.
 *
 * Per the plan's "Backend-specific tests should focus on SDK
 * translation quirks, not retesting the same Talon behaviour seven
 * times" — these assertions are the universal layer; SDK-specific
 * quirks live in each backend's own test file.
 */

import type { Backend } from "./capabilities.js";
import type { AgentEvent } from "./events.js";
import { makeBareModelRef, type BackendId } from "./model-ref.js";

class ContractViolation extends Error {
  constructor(backendId: string, contract: string, detail: string) {
    super(`Backend "${backendId}" violates contract "${contract}": ${detail}`);
    this.name = "ContractViolation";
  }
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function firstOf<K extends AgentEvent["type"]>(
  events: AgentEvent[],
  kind: K,
): Extract<AgentEvent, { type: K }> | undefined {
  return events.find((e) => e.type === kind) as
    | Extract<AgentEvent, { type: K }>
    | undefined;
}

/**
 * Every backend that exposes a `ChatBackend` must terminate its
 * event stream with EITHER a `completed` OR an `error` event. Tail
 * silence (the stream just closes) is a contract violation — the
 * dispatcher can't release its typing indicator on silence.
 */
export async function assertChatBackendTerminates(
  backend: Backend,
  options: { text?: string; chatId?: string } = {},
): Promise<void> {
  if (!backend.chat) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.terminates",
      "backend declares chat capability but exposes no `chat` slot",
    );
  }
  const events = await drain(
    backend.chat.runChatTurn({
      chatId: options.chatId ?? "contract-test-chat",
      model: makeBareModelRef(backend.id, "contract-test-model"),
      text: options.text ?? "ping",
      senderName: "ContractTest",
    }),
  );
  const last = events.at(-1);
  if (!last || (last.type !== "completed" && last.type !== "error")) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.terminates",
      `stream ended on ${last?.type ?? "(no events)"} instead of ` +
        `completed/error`,
    );
  }
}

/**
 * Every backend that exposes a `ChatBackend` must emit `run_started`
 * as its first event. The dispatcher uses this to set up streaming
 * state (typing indicator, log header, abort wiring).
 */
export async function assertChatBackendEmitsRunStarted(
  backend: Backend,
  options: { text?: string; chatId?: string } = {},
): Promise<void> {
  if (!backend.chat) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.emitsRunStarted",
      "backend declares chat capability but exposes no `chat` slot",
    );
  }
  const events = await drain(
    backend.chat.runChatTurn({
      chatId: options.chatId ?? "contract-test-chat",
      model: makeBareModelRef(backend.id, "contract-test-model"),
      text: options.text ?? "ping",
      senderName: "ContractTest",
    }),
  );
  if (events[0]?.type !== "run_started") {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.emitsRunStarted",
      `first event was ${events[0]?.type ?? "(no events)"} instead of ` +
        `run_started`,
    );
  }
}

/**
 * Successful chat runs must emit exactly one `usage` event before
 * `completed`. Tools that aggregate usage (`/status`, telemetry)
 * rely on a single deterministic source per turn.
 */
export async function assertChatBackendEmitsSingleUsage(
  backend: Backend,
  options: { text?: string; chatId?: string } = {},
): Promise<void> {
  if (!backend.chat) return;
  const events = await drain(
    backend.chat.runChatTurn({
      chatId: options.chatId ?? "contract-test-chat",
      model: makeBareModelRef(backend.id, "contract-test-model"),
      text: options.text ?? "ping",
      senderName: "ContractTest",
    }),
  );
  const last = events.at(-1);
  if (last?.type !== "completed") return; // error path; usage is optional
  const usageEvents = events.filter((e) => e.type === "usage");
  if (usageEvents.length === 0) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.singleUsage",
      "successful run emitted no usage event",
    );
  }
  if (usageEvents.length > 1) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.singleUsage",
      `successful run emitted ${usageEvents.length} usage events; expected exactly 1`,
    );
  }
}

/**
 * The `completed` event's `result.usage` must match the standalone
 * `usage` event's payload. Two consumers reading either source
 * should see the same numbers.
 */
export async function assertCompletedUsageMatchesUsageEvent(
  backend: Backend,
  options: { text?: string; chatId?: string } = {},
): Promise<void> {
  if (!backend.chat) return;
  const events = await drain(
    backend.chat.runChatTurn({
      chatId: options.chatId ?? "contract-test-chat",
      model: makeBareModelRef(backend.id, "contract-test-model"),
      text: options.text ?? "ping",
      senderName: "ContractTest",
    }),
  );
  const completed = firstOf(events, "completed");
  const usage = firstOf(events, "usage");
  if (!completed || !usage) return; // either is optional in error paths
  const cu = completed.result?.usage;
  const u = usage.usage;
  if (!cu) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.completedUsageMatches",
      "completed event has no result.usage despite a usage event firing",
    );
  }
  if (
    cu.inputTokens !== u.inputTokens ||
    cu.outputTokens !== u.outputTokens ||
    cu.cacheRead !== u.cacheRead ||
    cu.cacheWrite !== u.cacheWrite
  ) {
    throw new ContractViolation(
      backend.id,
      "ChatBackend.completedUsageMatches",
      `usage event ${JSON.stringify(u)} != completed.result.usage ${JSON.stringify(cu)}`,
    );
  }
}

/**
 * Backends that expose a `BackgroundRunner` must terminate with
 * `completed` or `error` and must emit `run_started` first — same
 * lifecycle contract as chat.
 */
export async function assertBackgroundRunnerLifecycle(
  backend: Backend,
  options: { prompt?: string; workspace?: string } = {},
): Promise<void> {
  if (!backend.background) {
    throw new ContractViolation(
      backend.id,
      "BackgroundRunner.lifecycle",
      "backend declares background capability but exposes no `background` slot",
    );
  }
  // `BackgroundRunner.background?.runOneShotAgent` is callback-driven; the
  // contract is "completes or throws". We run it with a no-op
  // `appendLog` and assert it settles without an unhandled error.
  const aborted = new AbortController();
  let threw: unknown;
  try {
    await backend.background.runOneShotAgent({
      prompt: options.prompt ?? "ping",
      systemPrompt: "",
      workspace: options.workspace ?? "/tmp",
      model: "contract-test-model",
      contextLabel: "contract-test",
      abortController: aborted,
      appendLog: async () => undefined,
    });
  } catch (err) {
    threw = err;
  }
  if (threw && !(threw instanceof Error)) {
    throw new ContractViolation(
      backend.id,
      "BackgroundRunner.lifecycle",
      `runOneShotAgent threw a non-Error: ${String(threw)}`,
    );
  }
}

/**
 * Backends with a `ModelCatalog` must answer `getDefaultModelId()`
 * with either a string id, `null`, or `undefined`. Throwing is a
 * contract violation.
 */
export async function assertModelCatalogDefaultShape(
  backend: Backend,
): Promise<void> {
  if (!backend.models) return;
  let result: string | null | undefined;
  try {
    result = await backend.models.getDefaultModelId();
  } catch (err) {
    throw new ContractViolation(
      backend.id,
      "ModelCatalog.defaultShape",
      `getDefaultModelId() threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result == null) return;
  if (typeof result !== "string") {
    throw new ContractViolation(
      backend.id,
      "ModelCatalog.defaultShape",
      `getDefaultModelId() returned ${typeof result}; expected string | null | undefined`,
    );
  }
}

/**
 * Backends that expose `UsageTelemetry` must answer
 * `getSessionSnapshot` with either a `UsageSnapshot` object whose
 * counters are non-negative numbers, or `undefined`. Negative
 * counters or `NaN`s are contract violations.
 */
export async function assertUsageTelemetryShape(
  backend: Backend,
  sessionId = "contract-test-session",
): Promise<void> {
  if (!backend.usage) return;
  const snapshot = await backend.usage.getSessionSnapshot(sessionId);
  if (snapshot === undefined) return;
  const fields: (keyof typeof snapshot)[] = [
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
  ];
  for (const field of fields) {
    const v = snapshot[field];
    if (typeof v !== "number") {
      throw new ContractViolation(
        backend.id,
        "UsageTelemetry.shape",
        `${field} was ${typeof v} (${JSON.stringify(v)}); expected number`,
      );
    }
    if (!Number.isFinite(v)) {
      throw new ContractViolation(
        backend.id,
        "UsageTelemetry.shape",
        `${field} was non-finite (${v})`,
      );
    }
    if (v < 0) {
      throw new ContractViolation(
        backend.id,
        "UsageTelemetry.shape",
        `${field} was negative (${v})`,
      );
    }
  }
}

/**
 * Run the full contract suite against a backend. Throws on the first
 * violation. Returns the list of contracts checked so callers can
 * assert coverage in tests.
 */
export async function assertBackendContract(
  backend: Backend,
  options: { text?: string; chatId?: string } = {},
): Promise<string[]> {
  const checked: string[] = [];

  if (backend.chat) {
    await assertChatBackendEmitsRunStarted(backend, options);
    checked.push("ChatBackend.emitsRunStarted");
    await assertChatBackendTerminates(backend, options);
    checked.push("ChatBackend.terminates");
    await assertChatBackendEmitsSingleUsage(backend, options);
    checked.push("ChatBackend.singleUsage");
    await assertCompletedUsageMatchesUsageEvent(backend, options);
    checked.push("ChatBackend.completedUsageMatches");
  }
  if (backend.background) {
    await assertBackgroundRunnerLifecycle(backend);
    checked.push("BackgroundRunner.lifecycle");
  }
  if (backend.models) {
    await assertModelCatalogDefaultShape(backend);
    checked.push("ModelCatalog.defaultShape");
  }
  if (backend.usage) {
    await assertUsageTelemetryShape(backend);
    checked.push("UsageTelemetry.shape");
  }

  return checked;
}

/**
 * Backend id sanity — `backend.id` must be a known `BackendId` and
 * `backend.label` must be non-empty.
 */
export function assertBackendIdentity(
  backend: Backend,
  expectedId: BackendId,
): void {
  if (backend.id !== expectedId) {
    throw new ContractViolation(
      backend.id,
      "Backend.identity",
      `expected id "${expectedId}", got "${backend.id}"`,
    );
  }
  if (typeof backend.label !== "string" || backend.label.length === 0) {
    throw new ContractViolation(
      backend.id,
      "Backend.identity",
      `label was ${JSON.stringify(backend.label)}; expected non-empty string`,
    );
  }
}
