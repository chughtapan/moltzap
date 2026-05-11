# transport/

Wire-level dispatch.

- WS connection lifecycle.
- JSON-RPC method binding (`defineMethod`, `defineNetworkMethod`, `defineTaskMethod`, `defineAppMethod`).
- Per-request `DispatchContext` and the layer-scope tags that gate handler placement.

## Layer rules

| Direction | Allowed |
|---|---|
| Imports FROM | kernels only (`db`, `crypto`, `runtime`, `runtime-surface`, `adapters`, `config`, `logger`, `test-utils`) |
| Imports TO   | identity, network, task, app (any protocol layer composes on top) |

Transport is the lowest protocol layer. It does not know about identity, conversations, presence, or app hosts. Handlers live in their layer's `handlers/` directory and are bound via `defineXMethod` from this layer.

## Files (populated in 2A.2)

- `connection.ts` (from `ws/`)
- `context.ts` (from `rpc/`)
- `define-layered-method.ts` (from `rpc/`)
- `layer-scopes.ts` (from `rpc/`)
- `layer-boundary.types-check.ts` (from `rpc/`)
