/**
 * `RunPolicy` — the operational contract for one backend invocation.
 *
 * Pre-`RunPolicy`, backends branched on a loose `contextLabel`
 * string ("heartbeat", "dream", ambient chat) to decide which tools
 * were allowed, whether delivery tools needed an explicit chat_id,
 * whether to write to a log file, and how long the run could take.
 * That logic lived in every backend, in slightly different shapes.
 *
 * The policy collapses the decisions into one object. The dispatcher
 * builds the right policy for a run kind (chat / heartbeat / dream /
 * trigger / test); the backend just receives it and respects it.
 *
 * Phase 1 (this PR) defines the type and provides default factories.
 * Phase 4 wires the dispatcher to build policies and threads them
 * through the new `BackgroundRunner` / `ChatBackend` interfaces.
 */

import type { ToolFilter } from "./tool-descriptor.js";

/**
 * Categories of run. Different kinds need different tool surfaces,
 * timeouts, and delivery rules.
 *
 *   - `chat`: a user message in a live conversation. Delivery tools
 *     allowed, ambient chat known, persistent session, no fixed
 *     timeout (subject to backend defaults).
 *   - `heartbeat`: autonomous background tick. Full plugin surface,
 *     no ambient chat — delivery tools require explicit `chat_id`.
 *     Bounded timeout, log to heartbeat journal.
 *   - `dream`: memory-consolidation sweep. Mempalace + filesystem
 *     only. No outbound messaging. Bounded timeout.
 *   - `trigger`: long-running watcher script's wake-up turn. Like
 *     chat in tool surface but no ambient chat — the trigger names
 *     its chat explicitly.
 *   - `test`: deterministic surface for integration tests. Tests
 *     can inject their own filter to widen / narrow.
 */
export type RunKind = "chat" | "heartbeat" | "dream" | "trigger" | "test";

/**
 * Tool surface for this run. `filter` narrows the master registry.
 * `requireExplicitChatId` means delivery tools must accept a
 * `chat_id` argument rather than rely on ambient context.
 */
export interface ToolPolicy {
  filter?: ToolFilter;
  requireExplicitChatId: boolean;
}

/**
 * Whether the run is allowed to send messages to the user, and
 * which surface owns delivery.
 *
 *   - `mode: "ambient"` — delivery tools resolve `chat_id` from
 *     ambient frontend context (set up by the dispatcher before the
 *     run). Used for chat.
 *   - `mode: "explicit"` — delivery tools must carry `chat_id`
 *     themselves. Used for heartbeat / trigger.
 *   - `mode: "none"` — delivery tools are not exposed at all. Used
 *     for dream / test (unless the test policy widens it).
 */
export interface DeliveryPolicy {
  mode: "ambient" | "explicit" | "none";
}

/**
 * Wall-clock budgets. `softMs` lets the backend emit a progress
 * warning; `hardMs` aborts the run.
 */
export interface TimeoutPolicy {
  softMs?: number;
  hardMs: number;
}

/**
 * Where to send the run's structured log. `journal` is the heartbeat
 * journal (file path resolved by core), `dreamLog` is the dream
 * log, `inline` is a no-op (caller consumes the event stream
 * directly), `file` is an absolute path.
 */
export interface LoggingPolicy {
  destination: "journal" | "dreamLog" | "inline" | "file";
  filePath?: string;
}

/**
 * Whether to use a persistent session across runs. Chat keeps one
 * per chat-id (Codex `--conversation`, Claude SDK session resume).
 * Heartbeat / dream / trigger / test run fresh — no resume.
 */
export interface SessionPolicy {
  persistent: boolean;
}

/**
 * Whether MCP tool calls require human approval (currently always
 * `auto` in Talon — kept here so a future Phase doesn't have to
 * thread a new field through the policy object).
 */
export interface PermissionPolicy {
  approvalMode: "auto" | "manual";
}

/**
 * The full policy. Built once by core for each run, handed to the
 * backend, never mutated.
 */
export interface RunPolicy {
  kind: RunKind;
  label: string;
  tools: ToolPolicy;
  delivery: DeliveryPolicy;
  timeout: TimeoutPolicy;
  logging: LoggingPolicy;
  session: SessionPolicy;
  permissions: PermissionPolicy;
}

// ── Defaults ────────────────────────────────────────────────────────────────

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/**
 * Reference defaults for each run kind. Production code is free to
 * overlay specific fields (e.g. a longer timeout for a known-slow
 * model) but the shape stays stable. Tests use these as the
 * baseline policy.
 */
export function defaultRunPolicyFor(kind: RunKind): RunPolicy {
  switch (kind) {
    case "chat":
      return {
        kind,
        label: "chat",
        tools: { requireExplicitChatId: false },
        delivery: { mode: "ambient" },
        timeout: { hardMs: 15 * ONE_MINUTE_MS },
        logging: { destination: "inline" },
        session: { persistent: true },
        permissions: { approvalMode: "auto" },
      };
    case "heartbeat":
      return {
        kind,
        label: "heartbeat",
        tools: { requireExplicitChatId: true },
        delivery: { mode: "explicit" },
        timeout: { hardMs: ONE_HOUR_MS },
        logging: { destination: "journal" },
        session: { persistent: false },
        permissions: { approvalMode: "auto" },
      };
    case "dream":
      return {
        kind,
        label: "dream",
        tools: {
          requireExplicitChatId: false,
          filter: { excludeDelivery: true, excludeAmbientChatTools: true },
        },
        delivery: { mode: "none" },
        timeout: { hardMs: 30 * ONE_MINUTE_MS },
        logging: { destination: "dreamLog" },
        session: { persistent: false },
        permissions: { approvalMode: "auto" },
      };
    case "trigger":
      return {
        kind,
        label: "trigger",
        tools: { requireExplicitChatId: true },
        delivery: { mode: "explicit" },
        timeout: { hardMs: 15 * ONE_MINUTE_MS },
        logging: { destination: "inline" },
        session: { persistent: false },
        permissions: { approvalMode: "auto" },
      };
    case "test":
      return {
        kind,
        label: "test",
        tools: { requireExplicitChatId: false },
        delivery: { mode: "none" },
        timeout: { hardMs: 30_000 },
        logging: { destination: "inline" },
        session: { persistent: false },
        permissions: { approvalMode: "auto" },
      };
  }
}

/**
 * Whether the policy allows delivery tools at all.
 */
export function allowsDelivery(policy: RunPolicy): boolean {
  return policy.delivery.mode !== "none";
}

/**
 * Whether the policy needs an ambient chat-id to be set up by the
 * dispatcher before the backend runs. Heartbeat / trigger /
 * explicit-chat-id runs do NOT — they expect the model to pass
 * `chat_id` on every delivery tool call.
 */
export function requiresAmbientChat(policy: RunPolicy): boolean {
  return policy.delivery.mode === "ambient";
}
