# Router implementation

This folder contains the runnable Router behind the public `Router`
capability. The Router accepts authenticated opaque messages and serves
bounded endpoint-wide polls without owning application interpretation or
durable state.

Start with:

- `process.ts` loads configuration and runs the standalone process.
- `server.ts` is the actual composition root for the production Effect layers.
- `http.ts` exposes readiness plus authenticated send and poll routes.
- `rpc.ts` owns the private operation group, authenticated-request proof,
  handlers, and in-process dispatch.
- `send.ts` admits one signed message into the ordered feed.
- `poll.ts` returns the caller's next bounded batch.
- `feed.ts` owns volatile ordering, retention, and retry identity.
- `poll-cursor.ts` authenticates caller- and process-bound continuations.
- `poll-waiters.ts` owns the lifecycle of pending polls.
- `client.ts` implements the public `Router` capability over HTTP.

`contract.ts` owns the closed requests, results, operation values, client
failures, routes, limits, and representations shared by those boundaries.
`configuration.ts` remains a private implementation detail.

The package-root `server.ts` is only the public `./server` export facade. It
points at this folder's server composition without moving private
mechanisms into the package root.
