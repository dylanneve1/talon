/**
 * Memory — the in-band write path over the typed store: remember /
 * recall / forget (docs/memory-persona-plan.md §3.2).
 *
 * Three rules shape this module, and none of them live in the store:
 *
 *   - **Single claim, supersede-candidate.** A `remember` that restates
 *     something already on file does NOT insert a second row. The FTS
 *     near-duplicate probe runs first, and a hit comes back as a refusal
 *     naming the rows to supersede. The caller then either picks one
 *     (`replace_id`) or declares the claim genuinely separate (`force`).
 *   - **Trust comes from the chat, not the caller.** Anything learned on
 *     a multi-party surface is `group_chat` — never pinnable, never in
 *     the core view (plan §5) — and a `directive` cannot be planted from
 *     one at all.
 *   - **Writes never invalidate the prompt cache.** This module must not
 *     import `core/prompt/invalidation.js`. A `remember` that dropped
 *     every live session's prompt snapshot would turn a ~50-token claim
 *     into a 60–90 k cache write (plan §3.6). A fact learned mid-session
 *     reaches the model through turn retrieval, not the frozen core view.
 */

import {
  assertMemory,
  dropMemory,
  findSimilarMemories,
  formatMemory,
  getMemory,
  isMemoryKind,
  replaceStateKey,
  searchMemories,
  supersedeMemory,
  touchMemory,
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryRow,
  type MemorySource,
  type MemoryTrust,
} from "../../../storage/memory.js";
import { chatScope } from "../../../util/chat-id.js";
import { log } from "../../../util/log.js";
import type { ActionResult } from "../../types.js";
import type { SharedActionHandlers } from "./types.js";

/** `source.actor` on every row this path writes — the ownership marker. */
const REMEMBER_ACTOR = "remember";

/** Kinds whose subject is the chat itself when the caller names none. */
const CHAT_SCOPED_KINDS: readonly MemoryKind[] = ["episode", "relationship"];

/** Hard ceiling on `recall`, regardless of what the caller asks for. */
const MAX_RECALL_LIMIT = 20;

const KIND_LIST = MEMORY_KINDS.join(", ");

/**
 * The trust tier for a claim learned in this chat.
 *
 * A group chat is a multi-party surface: any participant can assert
 * anything, so what is learned there is `group_chat` — a tier the store
 * refuses to pin and the core view never carries (plan §5). A DM with
 * the operator, or a local terminal/native session, is the agent writing
 * for its own principal, so that is `agent`.
 *
 * "Group" is read off the canonical chat-id grammar (`chatScope` in
 * util/chat-id.ts), which is the only identity a gateway action holds.
 * When the grammar cannot tell — Teams' `teams_chat_…` is 1:1 and group
 * alike — this fails closed to `group_chat`: over-restricting a claim
 * costs a pin, under-restricting one is a permanent prompt injection.
 */
function trustForChat(chatKey: string): MemoryTrust {
  return chatScope(chatKey) === "dm" ? "agent" : "group_chat";
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}

/** Never let a store error escape as a throw — the gateway wants a result. */
function attempt(run: () => ActionResult): ActionResult {
  try {
    return run();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

function storedLine(id: number): ActionResult {
  const row = getMemory(id);
  return { ok: true, id, line: row ? formatMemory(row) : `#${id}` };
}

/** Clamp a caller-supplied limit into 1..max, defaulting to max. */
function clampLimit(raw: unknown, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return max;
  return Math.min(Math.floor(n), max);
}

/** `episode` / `relationship` default to the chat; everything else must say. */
function resolveSubject(
  kind: MemoryKind,
  raw: unknown,
  chatKey: string,
): string {
  const given = raw === undefined ? "" : String(raw).trim();
  if (given) return given;
  return CHAT_SCOPED_KINDS.includes(kind) ? chatKey : "";
}

/** The parts of a `remember` body that survive validation. */
type RememberClaim = {
  kind: MemoryKind;
  subject: string;
  text: string;
  trust: MemoryTrust;
  source: MemorySource;
  confidence?: number;
};

function parseClaim(
  body: Record<string, unknown>,
  chatKey: string,
): RememberClaim | ActionResult {
  const kind = body.kind;
  if (!isMemoryKind(kind))
    return fail(
      `Unknown kind "${String(kind ?? "")}" (expected one of ${KIND_LIST})`,
    );
  const text = String(body.text ?? "").trim();
  if (!text) return fail("Missing text — a memory is one written claim");
  const subject = resolveSubject(kind, body.subject, chatKey);
  if (!subject)
    return fail(`A ${kind} memory needs a subject (who or what it is about)`);
  const trust = trustForChat(chatKey);
  if (kind === "directive" && trust !== "agent")
    return fail(
      "A directive cannot be recorded from a group chat — durable standing " +
        "intent only comes from a direct conversation with the operator. " +
        "Record it as a fact instead, or ask the operator in a DM.",
    );
  const confidence =
    body.confidence === undefined ? undefined : Number(body.confidence);
  return {
    kind,
    subject,
    text,
    trust,
    source: { chat: chatKey, actor: REMEMBER_ACTOR },
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

/** The keyed-state path: a write replaces the live row for that key. */
function rememberState(
  body: Record<string, unknown>,
  claim: RememberClaim,
): ActionResult {
  if (body.replace_id !== undefined)
    return fail(
      "A state memory replaces the live row for its key — omit replace_id",
    );
  const key = String(body.key ?? "").trim();
  if (!key)
    return fail("A state memory requires a key (e.g. heartbeat.health)");
  const id = replaceStateKey(key, claim.text, claim.source, {
    subject: claim.subject,
    trust: claim.trust,
    ...(claim.confidence !== undefined ? { confidence: claim.confidence } : {}),
    reason: "remember: state",
  });
  return storedLine(id);
}

/** The explicit supersede: fold the new text into an existing live row. */
function rememberReplacing(
  replaceId: number,
  claim: RememberClaim,
): ActionResult {
  const target = getMemory(replaceId);
  if (!target) return fail(`No memory with id ${replaceId}`);
  if (target.droppedAt !== undefined)
    return fail(`Memory #${replaceId} is dropped; it cannot be superseded`);
  if (target.supersededBy !== undefined)
    return fail(
      `Memory #${replaceId} is already superseded by #${target.supersededBy}`,
    );
  if (target.kind !== claim.kind)
    return fail(
      `Memory #${replaceId} is a ${target.kind}, not a ${claim.kind} — a supersede keeps the row's kind`,
    );
  return storedLine(
    supersedeMemory(replaceId, claim.text, "remember: replaced"),
  );
}

/** The refusal that offers supersede-instead-of-append (plan §3.2). */
function nearDuplicate(similar: MemoryRow[]): ActionResult {
  return {
    ok: false,
    error: `Near-duplicate of #${similar[0]!.id}`,
    similar: similar.map((row) => formatMemory(row)),
    hint: "pass replace_id to supersede it, or force: true to store a separate claim",
  };
}

function rememberClaim(
  body: Record<string, unknown>,
  chatKey: string,
): ActionResult {
  const parsed = parseClaim(body, chatKey);
  if ("ok" in parsed) return parsed;
  if (parsed.kind === "state") return rememberState(body, parsed);

  if (body.replace_id !== undefined) {
    const replaceId = Number(body.replace_id);
    if (!Number.isInteger(replaceId) || replaceId <= 0)
      return fail(`Invalid replace_id "${String(body.replace_id)}"`);
    return rememberReplacing(replaceId, parsed);
  }

  if (body.force !== true) {
    const similar = findSimilarMemories(
      parsed.kind,
      parsed.subject,
      parsed.text,
    );
    if (similar.length > 0) return nearDuplicate(similar);
  }
  const { id } = assertMemory(parsed);
  log("gateway", `remember: [${parsed.kind}] ${parsed.subject} #${id}`);
  return storedLine(id);
}

function recallRows(body: Record<string, unknown>): ActionResult {
  const query = String(body.query ?? "").trim();
  if (!query) return fail("Missing query");
  const kind = body.kind;
  if (kind !== undefined && !isMemoryKind(kind))
    return fail(
      `Unknown kind "${String(kind)}" (expected one of ${KIND_LIST})`,
    );
  const rows = searchMemories(query, {
    ...(kind !== undefined ? { kind } : {}),
    limit: clampLimit(body.limit, MAX_RECALL_LIMIT),
  });
  if (rows.length === 0)
    return { ok: true, rows: [], note: "nothing stored matches" };
  // A retrieval hit is ranking feedback, not a content change: `touchMemory`
  // writes no history row, and nothing here invalidates the prompt cache.
  for (const row of rows) touchMemory(row.id);
  return { ok: true, rows: rows.map((row) => formatMemory(row)) };
}

function forgetRow(body: Record<string, unknown>): ActionResult {
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0)
    return fail(`Invalid id "${String(body.id ?? "")}"`);
  const reason = String(body.reason ?? "").trim();
  if (!reason)
    return fail(
      "A reason is required — every drop is auditable and reversible",
    );
  dropMemory(id, reason);
  log("gateway", `forget: #${id} (${reason})`);
  return { ok: true, id, text: `Dropped #${id} to the graveyard: ${reason}` };
}

export const memoryHandlers: SharedActionHandlers = {
  remember: (body, _chatId, _backend, chatKey) =>
    attempt(() => rememberClaim(body, chatKey)),
  recall: (body) => attempt(() => recallRows(body)),
  forget: (body) => attempt(() => forgetRow(body)),
};
