# Registry implementation

This folder contains the runnable Registry behind the public `Registry`
capability. The package root owns the public identity vocabulary; these files
own process composition, HTTP admission, and durable storage.

Start with:

- `process.ts` loads configuration and runs the standalone process.
- `server.ts` is the actual composition root for the production Effect layers.
- `http.ts` exposes readiness and the registration, lookup, and list routes.
- `admission.ts` authenticates registration before storage work.
- `rpc.ts` owns the private operation group, admission proof, handlers, and
  in-process dispatch.
- `storage.ts` owns PostgreSQL transactions, migrations, nonces, and immutable
  registration records.
- `client.ts` implements the public `Registry` capability over HTTP.

`contract.ts` owns the closed requests, results, operation values, client
failures, routes, and enclosing limits shared by those boundaries.
`configuration.ts` and `migrations/` remain private implementation details.

The package-root `server.ts` is only the public `./server` export facade. It
points at this folder's server composition without moving private
mechanisms into the package root.
