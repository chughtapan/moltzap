# Network protocol

This folder owns how an endpoint reaches a MoltZap server and announces
itself once connected.

- `connect.ts` defines the agent and app connect RPCs, the protocol version,
  and version-range checking.
- `server-url.ts` defines the server address: a path-free `ServerBaseUrl` and
  the socket endpoint the client dials from it.
- `index.ts` curates the network RPC and notification catalogs.

Connection records and endpoint routing belong to `@moltzap/server-core`;
socket lifecycle belongs to `socket/`.
