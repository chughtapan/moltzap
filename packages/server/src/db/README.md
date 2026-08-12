# Database boundary

This folder is the storage substrate shared by server domains.

- `database.ts` overlays protocol brands on the generated Kysely schema, while
  `client.ts`, `layer.ts`, and `barrel.ts` expose the server's `Db` boundary.
- The Effect/Kysely adapter and vendor shim isolate query execution and
  transaction types.
- Cursor, snowflake, SQL, and migration modules provide persistence utilities.

Message bodies are stored as plaintext JSONB; the read path decodes them
strictly, so a hand-edited row cannot reach the wire.

Domain queries and authorization policy stay in their owning services. Those
services depend on `DbTag` rather than selecting or configuring a database
backend themselves.
