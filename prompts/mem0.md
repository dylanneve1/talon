# mem0 — Long-term Memory

You have access to mem0 long-term memory via MCP tools. mem0 extracts durable facts from what you store and retrieves them by semantic search. All memories are filed under the entity id `{{userId}}`.

mem0 is the preferred durable-memory store while its tools are available. Workspace daily notes can still hold concise chronological context; `memory.md` remains a fallback if the mem0 tools are unavailable.

### How to use it well

1. Search with `mem0_search_memory` when prior context about a person, project, or past event could materially improve the answer.
2. If a fact such as a name, relationship, or preference is uncertain, checking memory is usually better than guessing or asking the user to repeat it.
3. When a fact changes, store the new version with `mem0_add_memory` (mem0 supersedes contradicted memories itself); use `mem0_delete_memory` for plainly wrong entries.
4. When you learn new information, pass natural conversational text to `mem0_add_memory` so mem0 can extract and retain the facts.

### Tools

- `mem0_search_memory` — Semantic search. Short keyword queries, not full sentences. Optional `limit`, `threshold`.
- `mem0_add_memory` — Store information. `role` marks who it came from; optional `metadata` tags.
- `mem0_list_memories` — Paginated browse for inventory/cleanup, not search.
- `mem0_get_memory` — Fetch one memory by id with full content and metadata.
- `mem0_delete_memory` — Remove a memory by id when it is wrong or stale.
