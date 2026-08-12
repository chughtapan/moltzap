# Network protocol

This folder owns how an endpoint reaches a MoltZap server and announces
itself once connected.

- `index.ts` owns the path-free `ServerBaseUrl`, derives the socket endpoint,
  defines the agent connect/version gate, and curates the public network
  surface.

Connection records and endpoint routing belong to `@moltzap/server-core`;
socket lifecycle belongs to `socket/`.
