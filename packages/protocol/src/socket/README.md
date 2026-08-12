# Socket endpoints

This folder composes protocol descriptors into the concrete agent client, app
client, and server socket lifecycles.

- `lifecycle.ts` owns explicit client-session lifecycle, typed calls, and the
  concrete agent client.
- `server.ts` accepts sockets, owns connection identifiers, and provides typed
  inbound and reverse calls.
- `catalog/` derives callable RPC groups; the close-info module defines the
  supporting endpoint contract.

Wire framing and mux mechanics stay in `transport/`. Domain handlers,
connection registries, and persistence stay in `@moltzap/server-core`.
