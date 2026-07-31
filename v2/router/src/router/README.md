# Router implementation

This folder contains the runnable Router behind the public `Router`
capability. The Router accepts authenticated opaque messages and serves
bounded endpoint-wide polls without owning application interpretation or
durable state.

Start with:

- `process.ts` loads configuration and runs the standalone process.
- `server.ts` composes the production Effect layers.
- `http.ts` exposes readiness plus authenticated send and poll routes.
- `send.ts` admits one signed message into the ordered feed.
- `poll.ts` returns the caller's next bounded batch.
- `feed.ts` owns volatile ordering, retention, and retry identity.
- `poll-cursor.ts` authenticates caller- and process-bound continuations.
- `client.ts` implements the public `Router` capability over HTTP.

`operations.ts` is the closed request/result contract shared by those
boundaries. Supporting files keep held polls, request context, configuration,
and internal values private to this implementation.
