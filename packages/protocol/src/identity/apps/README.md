# App identity contracts

This folder defines the branded `AppId`, the default app identifier, redacted
app credentials, and the schema and validator for app manifests. `index.ts`
curates that value-contract surface.

The boundary describes app identity and policy configuration only. App
registration, endpoint tracking, callback execution, and persistence belong to
the server and socket layers.
