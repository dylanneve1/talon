# SQL sources

Every SQL statement in the codebase lives in the `.sql` files here —
the repositories and `db.ts` contain no SQL text.

- `schema.sql` — the complete schema. Every statement is idempotent
  (`IF NOT EXISTS`) and the whole file is applied on every database
  open, so fresh and existing databases both end up current. Reshaping
  something that already shipped needs an explicit upgrade path, not
  an edit here.
- `<store>.sql` — named statements, one per `-- name: <key>` marker,
  consumed by `repositories/<store>-repo.ts`.

Compiled single-binary builds (`bun build --compile`) have no source
tree at runtime, so the statements must travel inside the bundle:
`npm run build:sql` embeds the `.sql` files into the committed
`statements.generated.ts` (see `embed.ts`). After editing any `.sql`
file, regenerate and commit both — `sql-embed.test.ts` fails on drift.
