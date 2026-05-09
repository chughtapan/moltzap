# transport/

Wire-level dispatch. Frame codec, RPC routing, WebSocket connection
manager. The lowest protocol-bearing layer in the server.

## Post-Phase-2A.2 contents

- `connection.ts` (from `ws/connection.ts`) — `ConnectionManager`,
  `MoltZapConnection`.
- `connection.test.ts`, `connection.test-utils.ts`,
  `connection.app-callback.test.ts` (from `ws/`).
- `context.ts` (from `rpc/context.ts`) — `defineMethod`,
  `RpcMethodRegistry`, `AuthenticatedContext`.
- `define-layered-method.ts` (from `rpc/`) — typed-method factory.
- `layer-scopes.ts`, `layer-boundary.types-check.ts` (from `rpc/`).

## Public surface

`@moltzap/server-core/transport` re-exports the symbols above.
Skeleton stage: empty; barrel populates in 2A.2.

## Import policy

| From         | To                           | Allowed?                |
|--------------|------------------------------|-------------------------|
| transport    | _infra                       | Yes                     |
| transport    | identity, network, task, app | NO (downward only)      |
| any layer    | transport                    | Yes (via subpath import)|
