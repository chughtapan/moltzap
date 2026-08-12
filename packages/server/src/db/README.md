# Database boundary

This folder is the storage substrate shared by server domains.

- `database.ts` owns the Kysely row map, protocol brands, and `Db` type, while
  `layer.ts` and `barrel.ts` expose the server's database boundary.
- The Effect/Kysely adapter owns query execution and transaction helpers.
- Cursor, snowflake, and migration modules provide persistence utilities.

Message bodies are stored as plaintext JSONB; the read path decodes them
strictly, so a hand-edited row cannot reach the wire.

Domain queries and authorization policy stay in their owning services. Those
services depend on `DbTag` rather than selecting or configuring a database
backend themselves.
