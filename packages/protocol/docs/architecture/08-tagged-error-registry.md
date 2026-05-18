# 08 — Tagged error registry

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```mermaid
flowchart TD
    LOAD["module load order"]
    REGISTER["class HookBlockedError extends Data.TaggedError(...)<br>static readonly code = -32019<br>static readonly message = &quot;Hook blocked&quot;<br>registerErrorClass(HookBlockedError)<br>→ map.set(-32019, HookBlockedError)"]
    ALL_LAYERS["every domain layer registers its<br>tagged-error classes at load time"]
    UNION["RegisteredTaggedError union<br>type RegisteredTaggedError =<br>  UnauthorizedError | ForbiddenError | NotFoundError | …<br>  | HookBlockedError | TaskClosedError | …"]
    CLIENT["client side: wireErrorToRpcCallError<br>errorClassFor(code) → registered class | undefined"]
    CLASS_FOUND["new cls({data}) → RegisteredTaggedError instance<br>caller can Effect.catchTag(&quot;HookBlocked&quot;, …)"]
    CLASS_NOT_FOUND["new RpcServerError({code, message, data})<br>caller catches by &quot;RpcServerError&quot; tag + branches on code"]
    SERVER["server side: wireErrorFromInstance<br>isRegisteredErrorInstance(value)?<br>→ wireErrorPayload(cls, message, data)<br>→ wire error sub-object"]

    LOAD --> REGISTER --> ALL_LAYERS --> UNION
    UNION --> CLIENT
    CLIENT -->|"class found"| CLASS_FOUND
    CLIENT -->|"undefined"| CLASS_NOT_FOUND
    UNION --> SERVER
```

**Annotations:**

- `registerErrorClass` — `wire-errors.ts → registerErrorClass`
- `RegisteredTaggedError` union — `rpc-registry.ts → RegisteredTaggedError`; must be hand-kept in sync with registry; type system cannot enumerate the static-side registry into a union
- `wireErrorToRpcCallError` — `json-rpc-client.ts → wireErrorToRpcCallError`
- `wireErrorFromInstance` — `json-rpc-server.ts → wireErrorFromInstance`

`JSON_RPC_RESERVED_CODES` (in `json-rpc-server.ts`) covers only
the JSON-RPC 2.0 spec codes (-32700 ParseError, -32600 InvalidRequest,
-32601 MethodNotFound, -32602 InvalidParams, -32603 InternalError). Domain
codes are in the registry, not in a central table.
