# Talon prompt architecture

Everything the model reads at session start is assembled from the files in
this directory by `src/core/prompt/assemble.ts`. This README is the map.

## Assembly order

The system prompt is an ordered list of markdown sections joined by `---`
dividers, split into a **static** prefix (stable for a session's lifetime,
eligible for provider prompt caching) and a **dynamic** tail (volatile,
placed after the cache boundary):

| #   | Section               | Source                                                                 | Part          |
| --- | --------------------- | ---------------------------------------------------------------------- | ------------- |
| 1   | Identity              | `identity.md` + `~/.talon/workspace/identity.md`                       | static        |
| 2   | Core behaviour        | `custom.md` (replaces `base.md` when present)                          | static        |
| 3   | Frontend capabilities | `<frontend>.md` (telegram / discord / teams / terminal)                | static        |
| 4   | Persistent memory     | `system/persistent-memory.md` wrapping `memory/memory.md`, size-capped | static        |
| 5   | Capability docs       | `system/workspace.md`, `system/cron.md`, `system/triggers.md`          | static        |
| 6   | Plugin additions      | each plugin's `systemPrompt()` contribution                            | static        |
| 7   | **Delivery contract** | `system/contract-*.md`, appended by the **backend** as its suffix      | static (tail) |
| 8   | Daily-memory pointer  | `system/daily-memory.md` (names today's file)                          | dynamic       |
| 9   | Workspace listing     | generated tree of `~/.talon/workspace/`                                | dynamic       |

The delivery contract is deliberately LAST in the static prefix: it is the
one section the model must not miss, and the end of the prompt is the
highest-salience position.

## File ownership — two kinds of prompt files

**User-editable prompts** (everything at the top level of this directory:
`identity.md`, `base.md`, `custom.md`, `telegram.md`, `discord.md`,
`teams.md`, `terminal.md`, `heartbeat.md`, `dream.md`, `mempalace.md`) are
seeded once into `~/.talon/prompts/` on first run and read from there.
User edits always win; package updates never overwrite them.

**System templates** (`system/*.md`) are read directly from the package and
are NOT seeded. They document runtime behaviour that is versioned with the
code — delivery tool names, flow enforcement, trigger limits. A stale
seeded copy would silently describe a contract the code no longer
implements, so these are not user-customisable.

Templates support a minimal syntax (`src/core/prompt/templates.ts`):
`{{var}}` substitution and `{{#if var}}…{{/if}}` conditionals. Nothing else.

## The delivery contract (response flow)

How a reply reaches the user is a property of the **backend**, not the
frontend, so it never belongs in the frontend `.md` files:

- `system/contract-tool-only.md` — claude-sdk, openai-agents. The output
  stream is private scratchpad; replies MUST go through a delivery tool
  (`end_turn` / `send` / `react`). A prose-only turn triggers one
  `[FLOW VIOLATION]` re-prompt, then a silent drop.
- `system/contract-text-or-tools.md` — codex, kilo. Plain assistant text
  is the reply; delivery tools add targeting / rich content.
- `system/contract-text-preferred.md` — opencode. Plain text is the
  normal route; tools only for genuine side effects.

The delivery TOOL NAMES are per-frontend (`end_turn`/`send`/`react` on
telegram & discord, `end_turn`/`send_message` on teams) and are injected
into the templates by `src/backend/shared/delivery-contract.ts`, which is
also where the frontend-aware `[FLOW VIOLATION]` reminder and the
first-turn nudge (appended to the turn-0 user message) are built.

When editing frontend `.md` files, describe what the frontend can DO
(tools, formatting, culture); never re-state how replies are delivered —
the contract section wins, and duplicated contract text has already caused
contradictions between backends.

## Task prompts

`heartbeat.md` and `dream.md` are not part of the chat system prompt — they
are standalone prompts for the background heartbeat and memory-consolidation
(dream) agents, loaded by `src/core/background/heartbeat.ts` /
`src/core/background/dream.ts`.

## Token budget

The static prompt is read on EVERY session: every sentence must earn its
tokens. Per-tool parameter details and examples belong in the MCP tool
descriptions (which the model also has in context), not here. The memory
section is capped (`MEMORY_INJECT_MAX_CHARS`) and the workspace listing
collapses directories with more than 8 entries.
