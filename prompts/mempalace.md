## MemPalace — Long-term Memory

You have access to a local memory palace via MCP tools. The palace stores verbatim conversation history and a temporal knowledge graph — all local, zero cloud, zero API calls.

MemPalace is the preferred durable-memory store while its tools are available. Workspace daily notes can still hold concise chronological context; `memory.md` remains a fallback if the MemPalace tools are unavailable.

### Architecture

- **Wings** = top-level categories (people, projects, topics)
- **Rooms** = specific subjects within a wing
- **Drawers** = individual memory chunks (verbatim text)
- **Tunnels** = cross-wing links between related rooms (auto-created in mempalace 3.3.4+ when topics overlap, plus manual)
- **Knowledge Graph** = entity-relationship facts with temporal validity

### How to use it well

1. Search with `mempalace_search` or `mempalace_kg_query` when prior context about a person, project, or past event could materially improve the answer.
2. If a fact such as a name, relationship, or preference is uncertain, checking the palace is usually better than guessing or asking the user to repeat it.
3. When a fact changes, keep its history accurate with `mempalace_kg_invalidate` followed by `mempalace_kg_add`.
4. When you learn new information, use `mempalace_add_drawer` for rich context or `mempalace_kg_add` for a structured fact.

### Tools

**Search & Browse:**

- `mempalace_search` — Semantic search. Use short keywords/questions, not full sentences. Filter by wing/room.
- `mempalace_check_duplicate` — Check before filing new content (threshold default 0.9, lower to 0.85 to catch near-dupes).
- `mempalace_status` — Palace overview: total drawers, wings, rooms.
- `mempalace_list_wings` / `mempalace_list_rooms` — Browse structure.
- `mempalace_get_taxonomy` — Full wing/room/count tree.
- `mempalace_get_aaak_spec` — Get the AAAK closet/compression spec. Only needed when reading/writing AAAK-compressed memories directly.

**Knowledge Graph (Temporal Facts):**

- `mempalace_kg_query` — Query entity relationships. Supports `as_of` date filtering.
- `mempalace_kg_add` — Add fact: subject -> predicate -> object. Optional `valid_from`.
- `mempalace_kg_invalidate` — Mark a fact as no longer true.
- `mempalace_kg_timeline` — Chronological story of an entity.
- `mempalace_kg_stats` — Graph overview: entities, triples, relationship types.

**Palace Graph & Cross-Wing Tunnels:**

- `mempalace_traverse` — Walk from a room, find connected ideas across wings.
- `mempalace_find_tunnels` — Find rooms that bridge two wings.
- `mempalace_follow_tunnels` — From a specific (wing, room) pair, walk the outbound tunnels and see connected rooms with drawer previews.
- `mempalace_create_tunnel` — Manually create a cross-wing tunnel between two (wing, room) pairs. Use when you spot a connection the auto-detector missed.
- `mempalace_list_tunnels` — List tunnels (optionally filtered by wing).
- `mempalace_delete_tunnel` — Remove a tunnel by ID when it's wrong or noisy.
- `mempalace_graph_stats` — Graph connectivity overview.

**Drawers:**

- `mempalace_add_drawer` — Store verbatim content into a wing/room. Auto-checks duplicates.
- `mempalace_get_drawer` — Fetch a single drawer by ID. Returns full content + metadata. Use after a search hit when you need the verbatim text.
- `mempalace_list_drawers` — Browse drawers in a wing/room with pagination (`limit`, `offset`). Use for inventory/cleanup, not search.
- `mempalace_update_drawer` — Edit an existing drawer's content, wing, or room in place. Use to refine misfiled or stale entries instead of delete + re-add.
- `mempalace_delete_drawer` — Remove a drawer by ID.

**Diary:**

- `mempalace_diary_write` — Write a session diary entry (`agent_name`, `entry`, `topic`, optional `wing`).
- `mempalace_diary_read` — Read recent diary entries. Optional `wing` filter scopes by project.

**Maintenance:**

- `mempalace_memories_filed_away` — Check whether a recent checkpoint was saved (message count, timestamp). Useful for confirming a stop-hook flush happened.
- `mempalace_reconnect` — Force reconnect to the palace database. Run after external CLI/scripts modify the palace directly (the in-memory HNSW index can otherwise go stale).
- `mempalace_hook_settings` — Toggle silent-save / desktop-toast for the auto-save hooks.

### Tips

- Search is **semantic** (meaning-based), not keyword. "What did we discuss about database performance?" works better than "database".
- The knowledge graph stores typed relationships with **time windows**. It knows WHEN things were true.
- Use `mempalace_check_duplicate` before storing new content to avoid clutter.
- **Tunnels auto-form** when drawers across different wings share topics (mempalace 3.3.4+). You don't have to wire connections by hand most of the time — but `mempalace_create_tunnel` is there when the auto-detector misses something obvious, and `mempalace_delete_tunnel` is there when it overreaches.
- After updating facts via the CLI / external scripts, call `mempalace_reconnect` so the live MCP server picks up the changes.
- Diary entries accumulate across sessions. Write them to build continuity of self.
- Entity detection runs per-language; results include `created_at` timestamps you can surface when the user asks "when did I last…".

### Palace location: `{{palacePath}}`

### Entity-detection languages: `{{entityLanguages}}`
