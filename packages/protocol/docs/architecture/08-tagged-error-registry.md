# 08 — Tagged error registry

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```text
module load order
   │
   ▼  class HookBlockedError extends Data.TaggedError("HookBlocked")<{...}> {
   │      static readonly code = -32019
   │      static readonly message = "Hook blocked"
   │    }
   │    registerErrorClass(HookBlockedError)            wire-errors.ts → registerErrorClass
   │       │
   │       └─→ map.set(-32019, HookBlockedError)
   │
   ▼  every domain layer registers its tagged-error classes at load time
   │
   ▼  rpc-registry.ts → RegisteredTaggedError union
   │    type RegisteredTaggedError =
   │      | UnauthorizedError | ForbiddenError | NotFoundError | …
   │      | HookBlockedError | TaskClosedError | …
   │    (must be hand-kept in sync with registry; type system can't enumerate
   │     the static-side registry into a union)
   │
   ▼  client side: wireErrorToRpcCallError            originator.ts → wireErrorToRpcCallError
   │    errorClassFor(code) → registered class | undefined
   │      │
   │      ├─ class → new cls({data}) → RegisteredTaggedError instance
   │      │           caller can Effect.catchTag("HookBlocked", …)
   │      │
   │      └─ undefined → new RpcServerError({code, message, data})
   │                       caller catches by "RpcServerError" tag + branches on code
   │
   ▼  server side: wireErrorFromInstance              transport/dispatch.ts → wireErrorFromInstance
        isRegisteredErrorInstance(value)?
          ▼
        wireErrorPayload(cls, message, data) → wire `error` sub-object
```

`JSON_RPC_RESERVED_CODES` (in `transport/wire-errors.ts`) covers only
the JSON-RPC 2.0 spec codes (-32700 ParseError, -32600 InvalidRequest,
-32601 MethodNotFound, -32602 InvalidParams, -32603 InternalError). Domain
codes are in the registry, not in a central table.
