Add the endpoint store's forward migration runner with atomic private backups,
per-step rollback, pending-outbox admission before migration, and actionable
`newer-schema` startup failures. The current schema and reset policy remain in
force; no production migration is registered yet.
