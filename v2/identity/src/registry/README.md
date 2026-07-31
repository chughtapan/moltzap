# Registry implementation

This folder contains the runnable Registry behind the public `Registry`
capability. The package root owns the public identity vocabulary; these files
own process composition, HTTP admission, and durable storage.

Start with:

- `process.ts` loads configuration and runs the standalone process.
- `server.ts` composes the production Effect layers.
- `http.ts` exposes readiness and the registration, lookup, and list routes.
- `bootstrap-admission.ts` authenticates registration before storage work.
- `rpc.ts` connects admitted HTTP operations to the storage capability.
- `storage.ts` owns PostgreSQL transactions, migrations, nonces, and immutable
  registration records.
- `client.ts` implements the public `Registry` capability over HTTP.

`operations.ts` is the closed request/result contract shared by those
boundaries. Supporting files keep configuration, request context, and
migrations private to this implementation.
