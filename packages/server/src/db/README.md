# Database boundary

This folder is the storage substrate shared by server domains.

- `database.ts` overlays protocol brands on the generated Kysely schema, while
  `client.ts`, `layer.ts`, and `barrel.ts` expose the server's `Db` boundary.
- The Effect/Kysely adapter and vendor shim isolate query execution and
  transaction types.
- Cursor, SQL, migration, and Postgres-dialect modules provide backend-neutral
  persistence utilities.

Message bodies are stored as plaintext JSONB; the read path decodes them
strictly, so a hand-edited row cannot reach the wire.

`messages.seq` is a database-generated identity shared by every server process.
The write path locks the owning conversation row before inserting, so identity
allocation follows same-conversation commit order without serializing unrelated
conversations. A rollback can leave an identity gap, which checkpoint ranges
already tolerate. Deployments created before that identity shape must recreate
the database from `core-schema.sql` before starting the current binary; there is
no in-place migration path.

Domain queries and authorization policy stay in their owning services. Those
services depend on `DbTag` rather than selecting or configuring a database
backend themselves.
