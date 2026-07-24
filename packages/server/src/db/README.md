# Database boundary

This folder is the storage substrate shared by server domains.

- `database.ts` overlays protocol brands on the generated Kysely schema, while
  `client.ts`, `layer.ts`, and `barrel.ts` expose the server's `Db` boundary.
- The Effect/Kysely adapter and vendor shim isolate query execution and
  transaction types.
- Cursor, snowflake, SQL, migration, and Postgres-dialect modules provide
  backend-neutral persistence utilities.
- `crypto/` owns encryption at rest and key rotation.

Domain queries and authorization policy stay in their owning services. Those
services depend on `DbTag` rather than selecting or configuring a database
backend themselves.
