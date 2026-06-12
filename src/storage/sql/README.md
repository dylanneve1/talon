# SQL sources

Every SQL statement in the codebase lives in the `.sql` files here —
the repositories and `db.ts` contain no SQL text.

- `migrations/NNN_*.sql` — whole-file migration steps, applied in
  filename order. The cursor is `PRAGMA user_version` (see `db.ts`).
  Never edit or reorder a shipped migration — add a new file.
- `<store>.sql` — named statements, one per `-- name: <key>` marker,
  consumed by `repositories/<store>-repo.ts`.

Compiled single-binary builds (`bun build --compile`) have no source
tree at runtime, so the statements must travel inside the bundle:
`npm run build:sql` embeds the `.sql` files into the committed
`statements.generated.ts` (see `embed.ts`). After editing any `.sql`
file, regenerate and commit both — `sql-embed.test.ts` fails on drift.
