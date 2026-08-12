# Router implementation

This folder contains the runnable Router behind the public `Router`
capability. The Router accepts authenticated opaque messages and serves
bounded endpoint-wide polls without owning application interpretation or
durable state.

Start with:

- `../server.ts` is the composition root launched directly by the standalone
  binary.
- `http.ts` exposes readiness plus authenticated send and poll routes.
- `rpc.ts` owns the private operation group, authenticated-request proof,
  handlers, and in-process dispatch.
- `send.ts` admits one signed message into the ordered feed.
- `poll.ts` returns the caller's next bounded batch.
- `feed.ts` owns volatile ordering, retention, and retry identity.
- `poll-cursor.ts` authenticates caller- and process-bound continuations.
- `poll-waiters.ts` owns the lifecycle of pending polls.
- `../router.ts` owns the public `Router` capability over HTTP and the private
  process configuration consumed by the server.

`contract.ts` owns the closed requests, results, operation values, client
failures, routes, limits, and representations shared by those boundaries.

The package root exports only the public capability and contract values;
the `./server` subpath exposes only the production process surface.
