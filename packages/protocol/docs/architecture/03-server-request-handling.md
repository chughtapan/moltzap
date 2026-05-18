# 03 — Server request handling

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`makeJsonRpcServer` builds a method→handler map at construction time and
serves through a single `handle(frame, ctx)` entry point:

```mermaid
flowchart TD
    ENTRY["makeJsonRpcServer.handle(frame, ctx)"]
    LOOKUP["handlerByMethod.get(frame.method)"]
    NOT_FOUND["methodNotFoundResponse\ncode: -32601"]
    DECODE_PARAMS["decodeRpcParams(handler.definition, frame.params)"]
    INVALID_PARAMS["invalidParamsResponse\ncode: -32602"]
    HANDLE["handler.handle(params, ctx)"]
    SUCCESS_RSP["successResponse\nlogInfo + result"]
    FAILURE["failureResponse(cause)\nwireErrorFromInstance(failure)"]
    TAGGED["knownWireErrorResponse\nlogWarning + code (from registry)"]
    INTERNAL["internalErrorResponse\nlogError + cause\ncode: -32603"]
    OUT["ResponseFrame"]

    ENTRY --> LOOKUP
    LOOKUP -->|"undefined"| NOT_FOUND
    LOOKUP -->|"RpcHandler"| DECODE_PARAMS
    DECODE_PARAMS -->|"Failure"| INVALID_PARAMS
    DECODE_PARAMS -->|"Success"| HANDLE
    HANDLE -->|"Exit.isSuccess"| SUCCESS_RSP
    HANDLE -->|"Exit.isFailure"| FAILURE
    FAILURE -->|"tagged-error"| TAGGED
    FAILURE -->|"generic cause"| INTERNAL
    NOT_FOUND --> OUT
    INVALID_PARAMS --> OUT
    SUCCESS_RSP --> OUT
    TAGGED --> OUT
    INTERNAL --> OUT
```

Tagged error mapping (in `json-rpc-server.ts → wireErrorFromInstance`): the
server uses `isRegisteredErrorInstance` to check whether the failure carries
a `static readonly code`/`message` set by `registerErrorClass`. If so, the
class's code + the instance's message + the instance's `data` ride the wire.
Anything else collapses to `InternalError` (-32603) with `Cause.pretty(cause)`
logged but **not** sent to the client.

Handlers are bound via the `handler(definition, fn)` factory (in
`json-rpc-server.ts → handler`). The cast erases descriptor-typed params to
`unknown` for storage; runtime `decodeRpcParams` produces the `ParamsOf<D>`
shape, so the erasure is safe.
