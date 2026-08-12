# socket/

Server-side WebSocket connection/session primitives.

The protocol package owns the RPC catalogs, socket lifecycle classes, and
requirement middleware tags. `standalone.ts` supplies the server-side protocol
adapter. This folder only owns the live connection registry and context value
types used by server services.

## Files

- `connection.ts` — connection manager and reverse-client alias used by
  server services.
- `context.ts` — server auth context value types.

## Flow

1. `standalone.ts` opens a protocol `MoltZapServer` session and registers an
   unauthenticated connection in `ConnectionManager`.
2. `agent/network/connect` authenticates the live connection arm.
3. Domain services read connection/context primitives through `#socket`.
4. Socket close removes the connection and updates routing state.
