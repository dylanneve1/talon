/**
 * User-prompt formatting for backends.
 *
 * Every backend formats incoming user messages the same way before handing
 * them to its underlying SDK: optional `[YYYY-MM-DD HH:MM:SS]` time tag,
 * optional `[Name]` sender label for group chats, optional `[msg_id:N]`
 * reference for tool-use targeting, then the user text.
 *
 * Centralising this prevents the "Claude SDK adds the time tag, Kilo
 * doesn't" drift that motivated the shared-framework refactor.
 *
 * Examples:
 *   group:  "[2026-05-15 11:01:23] [Dylan] [msg_id:2485]: actual text"
 *   DM:     "[2026-05-15 11:01:23] [msg_id:2485] actual text"
 *   DM (no msg_id): "[2026-05-15 11:01:23] actual text"
 */

import type { RetrievedMemory } from "../../core/agent-runtime/capabilities.js";
import { formatFullDatetime } from "../../util/time.js";

// ── Public API ──────────────────────────────────────────────────────────────

/** Inputs for `formatUserPrompt`. */
export type PromptFormatInputs = {
  /** Raw user text — passed through verbatim. */
  text: string;
  /** Display name of the sender (e.g. "Dylan"). */
  senderName: string;
  /** True when the chat is a group; influences whether the `[Name]` label is included. */
  isGroup?: boolean;
  /** Provider message id (Telegram numeric, Discord snowflake string). */
  messageId?: number | string;
  /** When true, omit the leading `[YYYY-MM-DD HH:MM:SS]` tag. */
  omitTimeTag?: boolean;
};

/**
 * Format a user prompt for the AI backend.
 *
 * The shape matches what the Claude SDK backend has shipped since the
 * v1.10.x window — all later backends should consume this helper so the
 * model receives a consistent input contract regardless of which provider
 * is on the other end.
 */
export function formatUserPrompt(inputs: PromptFormatInputs): string {
  const timeTag = inputs.omitTimeTag ? "" : `[${formatFullDatetime()}]`;
  const msgIdHint =
    inputs.messageId !== undefined ? ` [msg_id:${inputs.messageId}]` : "";

  if (inputs.isGroup) {
    return joinNonEmpty(
      timeTag,
      `[${inputs.senderName}]${msgIdHint}:`,
      inputs.text,
    );
  }

  // DM: no [Name] label needed (Telegram already shows sender)
  if (msgIdHint) {
    return joinNonEmpty(`${timeTag}${msgIdHint}`.trim(), inputs.text);
  }
  return joinNonEmpty(timeTag, inputs.text);
}

// ── Retrieved-memory wrapper (Phase B pre-retrieval) ────────────────────────

/** Default hard cap on the injected memory block, provenance labels included. */
export const RETRIEVED_MEMORY_DEFAULT_MAX_CHARS = 3000;

/**
 * Wrap an already-formatted live user prompt with a bounded retrieved-memory
 * block. This is the ONLY place retrieved memory enters a prompt, and it
 * wraps the whole `formatUserPrompt(...)` output rather than rebuilding its
 * internals — the existing sender/time/msg_id wrapper stays intact inside the
 * `User message:` section.
 *
 * Contract (see docs/memory-phase-b-pre-retrieval.md):
 *   - `memory` undefined or empty items → the prompt is returned
 *     BYTE-IDENTICAL. Prompt-cache and prompt-format tests stay valid.
 *   - Non-empty → emit `Relevant memory:` with one provenance-labelled line
 *     per item, a blank line, `User message:`, then the original prompt.
 *   - The memory block (labels included) is capped at `maxChars`; item text
 *     is truncated deterministically with an ellipsis marker. The user
 *     message itself is NEVER dropped or truncated.
 *   - This block is dynamic turn context: callers must keep it out of
 *     `prepareSystemPrompt()`, prompt additions, and backend `system` fields.
 */
export function formatPromptWithRetrievedMemory(
  prompt: string,
  memory?: RetrievedMemory,
  maxChars: number = RETRIEVED_MEMORY_DEFAULT_MAX_CHARS,
): string {
  if (!memory || memory.items.length === 0) return prompt;

  const header = "Relevant memory:";
  const footer = "User message:";
  // Budget applies to the memory block only (header + item lines), so the
  // user message can never be squeezed out.
  let budget = Math.max(0, maxChars) - header.length - 1; // "\n" after header
  const lines: string[] = [];
  for (const item of memory.items) {
    const label = provenanceLabel(item.wing, item.room, item.sourceFile);
    const prefix = `- ${label} `;
    if (prefix.length >= budget) break;
    const text = sanitizeInline(item.text);
    const room = budget - prefix.length - 1; // "\n" for this line
    const body =
      text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
    if (body.length === 0) break;
    const line = `${prefix}${body}`;
    lines.push(line);
    budget -= line.length + 1;
  }
  if (lines.length === 0) return prompt;

  return `${header}\n${lines.join("\n")}\n\n${footer}\n${prompt}`;
}

function provenanceLabel(
  wing: string,
  room?: string,
  sourceFile?: string,
): string {
  const path = room ? `${wing}/${room}` : wing;
  return sourceFile ? `[${path} ${sourceFile}]` : `[${path}]`;
}

/** Collapse newlines/control whitespace so one item stays one labelled line. */
function sanitizeInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function joinNonEmpty(...parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(" ");
}
