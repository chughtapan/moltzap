# moltzap/

Server-side MoltZap protocol adapter.

This folder is where protocol catalogs, requirement middleware implementations,
principal gates, and the `MoltZapServer` socket adapter meet server-core
services.

## Files

- `handler-catalog.ts` — the RPC handler map consumed by `MoltZapServer`.
- `handler-runtime.ts` — request principal reads for already-gated handlers.
- `auth-middleware-layers.ts` — one server Layer per protocol requirement tag.
- `principal-gate.ts` — live connection arm lookup and principal narrowing.
- `layer-tags.ts` — handler service-tag allowlists by protocol layer.
- `server-socket.ts` — bridges an Effect socket to `MoltZapServer` sessions.

`core/` owns runtime/service boot. `socket/` owns connection/session primitives.
Protocol-specific composition belongs here.
