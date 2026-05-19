# 01 — Method-definition pipeline

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Every wire method is born at module-load time by a single `defineRpc` call.
The factory compiles AJV validators eagerly so every wire boundary uses
identical schema semantics:

```text
            domain layer (e.g. task/methods.ts)
                       │
                       ▼  defineRpc({ name, params, result,         transport/method.ts → defineRpc
                       │              slotDisposition?, capabilities? })
                       │              (slotDisposition + capabilities are Spec F G4/G5;
                       │               absent = REQUIRED slot, no capability auto-provision)
                       │
       ┌───────────────┴────────────────────────────┐
       ▼                                            ▼
  ajv.compile(params)                          ajv.compile(result)
  → validateParams predicate                   → validateResult predicate
       │                                            │
       └────────────┬───────────────────────────────┘
                    ▼
            RpcDefinition<Name, P, R> {
              name (branded)                                method.ts → RpcDefinition type
              paramsSchema / resultSchema (TypeBox)
              validateParams / validateResult (Ajv)
              encodeRequest(id, params) → RequestFrame      wire.ts → requestFrame (wrapped per-descriptor)
              encodeResponse(id, result) → ResponseFrame    wire.ts → responseFrame (wrapped per-descriptor)
            }
                    │
                    ▼
       pushed into per-layer `*RpcMethods` const
                    │
                    ▼
       aggregated into `rpcMethods` (rpc-registry.ts → rpcMethods)
       union typed as `AnyRpcDefinition` (rpc-registry.ts → AnyRpcDefinition)
```

`defineNotification` is the same pipeline minus the result schema and minus
the response encoder. Method names are branded `JsonRpcMethod<"the.name">`
so a runtime string can never accidentally type-fit a method position
(wire.ts → JsonRpcMethod branded type).
