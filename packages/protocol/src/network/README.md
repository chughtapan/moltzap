# Network protocol

This folder owns how an endpoint reaches a MoltZap server and announces
itself once connected.

- `connect.ts` defines the agent and app connect RPCs, the protocol version,
  and version-range checking.
- `presence.ts` defines the presence subscriptions.
- `server-url.ts` defines the server address: a path-free `ServerBaseUrl` and
  the socket endpoint the client dials from it.
- `index.ts` curates the network RPC and notification catalogs.

Connection records, endpoint routing, and presence bookkeeping belong to
`@moltzap/server-core`; socket lifecycle belongs to `socket/`.
