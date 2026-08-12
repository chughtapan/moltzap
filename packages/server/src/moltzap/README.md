# moltzap/

Server-side MoltZap protocol adapter.

This folder is where protocol catalogs, requirement middleware implementations,
principal gates, and the `MoltZapServer` socket adapter meet server-core
services.

## Files

- `principal-gate.ts` — live connection-arm lookup and principal narrowing for
  requirement middleware and already-gated handlers.
- `server-socket.ts` — binds the RPC handler and requirement Layer catalogs and
  bridges an Effect socket to `MoltZapServer` sessions.

`core/` owns runtime/service boot. `socket/` owns connection/session primitives.
Protocol-specific composition belongs here.
