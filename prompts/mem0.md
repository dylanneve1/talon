# mem0 — Long-term Memory

You have access to mem0 long-term memory via MCP tools. mem0 extracts durable facts from what you store and retrieves them by semantic search. All memories are filed under the entity id `{{userId}}`.

### Protocol — FOLLOW EVERY SESSION

1. **BEFORE RESPONDING** about any person, project, or past event: call `mem0_search_memory` FIRST. Never guess — verify from memory.
2. **IF UNSURE** about a fact (name, age, relationship, preference): search memory. Wrong is worse than slow.
3. **WHEN FACTS CHANGE**: store the new fact with `mem0_add_memory` (mem0 supersedes contradicted memories itself); delete plainly wrong entries with `mem0_delete_memory`.
4. **AFTER LEARNING** something important: store it with `mem0_add_memory`. Pass natural conversational text — mem0 extracts the durable facts.

### Tools

- `mem0_search_memory` — Semantic search. Short keyword queries, not full sentences. Optional `limit`, `threshold`.
- `mem0_add_memory` — Store information. `role` marks who it came from; optional `metadata` tags.
- `mem0_list_memories` — Paginated browse for inventory/cleanup, not search.
- `mem0_get_memory` — Fetch one memory by id with full content and metadata.
- `mem0_delete_memory` — Remove a memory by id when it is wrong or stale.
