# socket/

Server-side WebSocket runtime adapters around the protocol package.

The protocol package owns the RPC catalogs, socket lifecycle classes, and
requirement middleware tags. Server-core supplies the implementation pieces:
the live connection registry, principal narrowing, requirement middleware
Layers, and the bridge from an Effect `Socket` to the core services.

## Files

- `server-socket.ts` — creates `MoltZapServer` with the server handler map,
  per-socket requirement layers, per-socket `ConnectionTag`, and close cleanup.
- `connection.ts` — connection manager and reverse-client alias used by
  server services.
- `context.ts` — server auth context value types.
- `principal-gate.ts` — live-arm lookup and principal policy narrowing.
- `auth-middleware-layers.ts` — one server implementation Layer per protocol
  requirement tag.

## Flow

1. `core/app.ts` accepts an upgraded WebSocket and delegates to
   `makeCoreSocketHandler`.
2. `server-socket.ts` opens a protocol `MoltZapServer` session and registers an
   unauthenticated connection.
3. `agent/network/connect` or `app/network/connect` authenticates the live connection arm.
4. Later RPCs run protocol-declared requirement middleware before the handler
   body.
5. Socket close removes the connection, updates presence/routing state, abandons
   leases, and unregisters apps bound to the connection.
