# Registry implementation

This folder contains the runnable Registry behind the public
`@moltzap/identity/registry` capability. These files own Registry requests,
results, client failures, process composition, HTTP admission, and durable
storage.

Start with:

- `server.ts` validates process-environment configuration and composes the
  production Effect layers launched by the package executable.
- `http.ts` exposes readiness and the registration, lookup, and list routes.
- `admission.ts` authenticates registration before storage work.
- `rpc.ts` owns the private operation group, admission proof, handlers, and
  in-process dispatch.
- `storage.ts` owns PostgreSQL transactions, migrations, nonces, and immutable
  registration records.
- `client.ts` implements the public `Registry` capability over HTTP.

`contract.ts` owns the closed requests, results, operation values, client
failures, routes, and enclosing limits shared by those boundaries.
`migrations/` remains a private implementation detail.

Consumers that compose the Registry process import `layer` and `StartupError`
directly from `@moltzap/identity/registry/server`.
