/**
 * Memory tools — one typed claim at a time, in band.
 *
 * `remember` / `recall` / `forget` are the write path of
 * docs/memory-persona-plan.md §3.2: a claim costs ~50 tokens and a
 * transaction instead of a 23 KB file rewrite mid-conversation, and a
 * restatement is offered back as a supersede candidate rather than
 * silently becoming a second row.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import type { MemoryKind } from "../../storage/memory.js";

/**
 * The store's kinds, spelled out here rather than imported.
 * `core/tools/` holds pure definitions; importing `storage/memory.js`
 * for one constant would pull SQLite (and `db.ts`'s top-level await)
 * into every backend that imports the tool registry. The `MemoryKind`
 * annotation is the compile-time link, and `memory-actions.test.ts`
 * asserts this list still equals `MEMORY_KINDS` exactly.
 */
const MEMORY_KIND_NAMES: readonly [MemoryKind, ...MemoryKind[]] = [
  "directive",
  "fact",
  "state",
  "episode",
  "relationship",
  "reflection",
];

const kindSchema = z
  .enum(MEMORY_KIND_NAMES)
  .describe(
    "directive = standing instruction; fact = durable and supersedable; state = keyed, replaced on write; episode = dated, decays; relationship = how a person works; reflection = your own diary, never a fact source",
  );

export const memoryTools: ToolDefinition[] = [
  {
    name: "remember",
    description: `Store one durable claim in long-term memory. Cheap — prefer it to editing memory files.

One claim per call, written as a standalone sentence that will still parse months from now.
If a near-duplicate already exists the call is REFUSED and lists the matching rows: re-issue with replace_id=<that id> to fold your wording into it (the old row stays readable), or force=true only when the new claim genuinely stands beside the old one.
subject is who/what the claim is about; it defaults to this chat for episode and relationship. state also needs a key (e.g. "release.status") and replaces that key's live row.`,
    schema: {
      kind: kindSchema,
      text: z
        .string()
        .describe(
          "The claim itself, self-contained and specific (max 4000 chars)",
        ),
      subject: z
        .string()
        .optional()
        .describe(
          "Who or what this is about — a person, a project, a topic. Required except for episode/relationship, which default to this chat.",
        ),
      key: z
        .string()
        .optional()
        .describe(
          'Required for kind="state": lowercase dotted namespace (e.g. "heartbeat.health"). Writing a key replaces its live row.',
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("How sure you are, 0–1 (default 1)"),
      replace_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Supersede this existing memory with the new text instead of adding a row — the answer to a near-duplicate refusal",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Store anyway despite a near-duplicate. Only when the claims really are distinct.",
        ),
    },
    execute: (params, bridge) => bridge("remember", params),
    tag: "memory",
  },

  {
    name: "recall",
    description: `Search long-term memory for stored claims — full-text, best match first.

Use it when you need more than the memory already in this prompt, before asking the user to repeat something. Returns lines prefixed with an id you can pass to remember(replace_id) or forget.`,
    schema: {
      query: z
        .string()
        .describe("Words to search for — names, topics, distinctive phrases"),
      kind: kindSchema.optional().describe("Restrict to one kind"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max rows to return (default and max 20)"),
    },
    execute: (params, bridge) => bridge("recall", params),
    tag: "memory",
  },

  {
    name: "forget",
    description: `Retire a stored memory by id. It goes to the graveyard — readable and revertible, not erased.

The reason is required and is kept with the row. Use this for claims that are wrong or that the user asked you to drop; to correct a claim that is merely out of date, use remember with replace_id so the correction supersedes it.
A claim can only be retired from a context at least as trusted as the one that recorded it: operator memories are never droppable this way, and a group chat cannot drop what was learned in a DM.`,
    schema: {
      id: z.number().int().positive().describe("Memory id, as shown by recall"),
      reason: z
        .string()
        .describe(
          "Why it is being dropped — required, stored in the audit log",
        ),
    },
    execute: (params, bridge) => bridge("forget", params),
    tag: "memory",
  },
];
